import { Router } from 'express';
import { bq } from '../services/bigquery.service';

const router = Router();
const DATASET_NAME = 'theme_park_queues';

router.post('/track', async (req, res) => {
  try {
    const { eventType, parkId, parkName, tabName, sessionId } = req.body;
    
    // Captura o IP real considerando o trust proxy do Render
    const ipHeader = req.headers['x-forwarded-for'];
    const cleanIp = Array.isArray(ipHeader) 
      ? ipHeader[0] 
      : (ipHeader ? ipHeader.split(',')[0].trim() : req.socket.remoteAddress);

    let country = 'Unknown';
    let city = 'Unknown';

    // Se não for IP local, consulta uma API de geolocalização em tempo real
    if (cleanIp && cleanIp !== '127.0.0.1' && cleanIp !== '::1') {
      try {
        const response = await fetch(`http://ip-api.com/json/${cleanIp}?fields=status,country,city,regionName`);
        const geoData = await response.json() as any; // <--- Adicione o "as any" aqui
        
        if (geoData.status === 'success') {
          country = geoData.country || 'Unknown';
          city = geoData.city || geoData.regionName || 'Unknown';
        }
      } catch (apiError) {
        console.warn('Erro ao consultar API de geolocalização:', apiError);
      }
    }

    const row = {
      timestamp: new Date().toISOString(),
      event_type: eventType,
      park_id: parkId || null,
      park_name: parkName || null,
      tab_name: tabName || null,
      country,
      city,
      session_id: sessionId || 'anonymous',
    };

    await bq.dataset(DATASET_NAME).table('user_events').insert([row]);

    return res.status(204).send();
  } catch (error) {
    console.error('Erro ao registrar analytics:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;