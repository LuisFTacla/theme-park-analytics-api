-- Tabelas agregadas que a API lê no lugar do histórico bruto.
-- Rodar UMA vez no console do BigQuery. Depois, rodar 02_atualizar_agregados.sql
-- manualmente uma vez (faz o preenchimento inicial) e agendá-lo diariamente.
--
-- Por que existem: perfil histórico, stats de atração e calendário liam a
-- tabela bruta inteira (~1-2 GB por consulta, crescendo todo dia). Somas e
-- contagens são aditivas, então dá pra acumulá-las de forma incremental e a
-- API só lê alguns MB.

-- Soma/contagem/máximo por atração e bloco de 5 min do horário LOCAL do parque,
-- acumulados em todos os dias. Alimenta o perfil histórico (parque e atração)
-- e a média/máxima histórica do modal de atração.
--   *_validos:   0 <= wait_time <= 300 (perfil do parque inclui fila zero)
--   *_positivos: 0 <  wait_time <= 300 (atração e calendário ignoram zero)
CREATE TABLE IF NOT EXISTS `theme-park-queue-data.theme_park_queues.agg_perfil_bloco` (
  park_id        INT64  NOT NULL,
  ride_name      STRING NOT NULL,
  hora           INT64  NOT NULL,
  minuto_bloco   INT64  NOT NULL,
  n_validos      INT64  NOT NULL,
  soma_validos   INT64  NOT NULL,
  n_positivos    INT64  NOT NULL,
  soma_positivos INT64  NOT NULL,
  max_valido     INT64
)
CLUSTER BY park_id, ride_name;

-- Soma/contagem por parque e data local. Alimenta o calendário.
CREATE TABLE IF NOT EXISTS `theme-park-queue-data.theme_park_queues.agg_media_diaria` (
  park_id        INT64 NOT NULL,
  data_local     DATE  NOT NULL,
  n_positivos    INT64 NOT NULL,
  soma_positivos INT64 NOT NULL
)
CLUSTER BY park_id;

-- Até onde (timestamp_utc, exclusivo) o histórico bruto já foi acumulado.
-- É o que torna a atualização incremental segura: rodar duas vezes não soma
-- nada em dobro, e se a atualização falhar alguns dias a próxima recupera.
CREATE TABLE IF NOT EXISTS `theme-park-queue-data.theme_park_queues.agg_controle` (
  processado_ate TIMESTAMP NOT NULL
);

INSERT INTO `theme-park-queue-data.theme_park_queues.agg_controle` (processado_ate)
SELECT TIMESTAMP('2000-01-01')
FROM UNNEST([1])
WHERE NOT EXISTS (SELECT 1 FROM `theme-park-queue-data.theme_park_queues.agg_controle`);
