-- Acumula nas tabelas agregadas tudo o que entrou no histórico bruto desde a
-- última execução. Agendar como Scheduled Query diária. A primeira execução
-- faz o preenchimento inicial (lê o histórico inteiro uma vez).
--
-- As regras abaixo precisam ficar em sincronia com a API
-- (theme-park-analytics-api/src/services/bigquery.service.ts):
--   * MAX_VALID_WAIT_TIME = 300
--   * RIDE_NAME_EXPR: 'Big Tower' -> 'Big Drop'

DECLARE inicio TIMESTAMP DEFAULT (
  SELECT MAX(processado_ate) FROM `theme-park-queue-data.theme_park_queues.agg_controle`
);
-- Para 1h antes da hora cheia atual: dá margem pra coleta que grava atrasada,
-- já que uma linha com timestamp anterior a `fim` que chegue depois da
-- execução nunca seria acumulada.
DECLARE fim TIMESTAMP DEFAULT TIMESTAMP_TRUNC(
  TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR), HOUR
);

IF inicio < fim THEN
  BEGIN TRANSACTION;

  MERGE `theme-park-queue-data.theme_park_queues.agg_perfil_bloco` AS t
  USING (
    SELECT
      park_id,
      CASE
        WHEN ride_name IN ('Big Tower', 'BIG TOWER', 'big tower') THEN 'Big Drop'
        ELSE ride_name
      END AS ride_name,
      EXTRACT(HOUR FROM DATETIME(timestamp_utc, timezone)) AS hora,
      DIV(EXTRACT(MINUTE FROM DATETIME(timestamp_utc, timezone)), 5) * 5 AS minuto_bloco,
      COUNT(*) AS n_validos,
      SUM(wait_time) AS soma_validos,
      COUNTIF(wait_time > 0) AS n_positivos,
      SUM(IF(wait_time > 0, wait_time, 0)) AS soma_positivos,
      MAX(wait_time) AS max_valido
    FROM `theme-park-queue-data.theme_park_queues.historical-data`
    WHERE timestamp_utc >= inicio
      AND timestamp_utc < fim
      AND wait_time <= 300
    GROUP BY park_id, ride_name, hora, minuto_bloco
  ) AS s
  ON  t.park_id = s.park_id
  AND t.ride_name = s.ride_name
  AND t.hora = s.hora
  AND t.minuto_bloco = s.minuto_bloco
  WHEN MATCHED THEN UPDATE SET
    n_validos      = t.n_validos + s.n_validos,
    soma_validos   = t.soma_validos + s.soma_validos,
    n_positivos    = t.n_positivos + s.n_positivos,
    soma_positivos = t.soma_positivos + s.soma_positivos,
    max_valido     = GREATEST(t.max_valido, s.max_valido)
  WHEN NOT MATCHED THEN INSERT ROW;

  MERGE `theme-park-queue-data.theme_park_queues.agg_media_diaria` AS t
  USING (
    SELECT
      park_id,
      DATE(timestamp_utc, timezone) AS data_local,
      COUNT(*) AS n_positivos,
      SUM(wait_time) AS soma_positivos
    FROM `theme-park-queue-data.theme_park_queues.historical-data`
    WHERE timestamp_utc >= inicio
      AND timestamp_utc < fim
      AND wait_time > 0
      AND wait_time <= 300
    GROUP BY park_id, data_local
  ) AS s
  ON t.park_id = s.park_id AND t.data_local = s.data_local
  WHEN MATCHED THEN UPDATE SET
    n_positivos    = t.n_positivos + s.n_positivos,
    soma_positivos = t.soma_positivos + s.soma_positivos
  WHEN NOT MATCHED THEN INSERT ROW;

  UPDATE `theme-park-queue-data.theme_park_queues.agg_controle`
  SET processado_ate = fim
  WHERE TRUE;

  COMMIT TRANSACTION;
END IF;
