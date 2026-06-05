// src/services/live.service.ts

import axios from 'axios';
import NodeCache from 'node-cache';
import { LiveRide, BCW_MECHANICAL_IDS } from '../types';

const cache = new NodeCache({ stdTTL: 60 }); // 60s de cache para dados ao vivo

export async function getLiveData(parkId: number): Promise<LiveRide[]> {
  const cacheKey = `live:${parkId}`;
  const cached = cache.get<LiveRide[]>(cacheKey);
  if (cached) return cached;

  const url = `https://queue-times.com/parks/${parkId}/queue_times.json`;

  const response = await axios.get(url, { timeout: 10000 });
  const data = response.data;

  const allRides: LiveRide[] = [];

  for (const land of data.lands ?? []) {
    for (const ride of land.rides ?? []) {
      allRides.push({ id: ride.id, name: ride.name, is_open: ride.is_open, wait_time: ride.wait_time });
    }
  }
  for (const ride of data.rides ?? []) {
    allRides.push({ id: ride.id, name: ride.name, is_open: ride.is_open, wait_time: ride.wait_time });
  }

  // Filtra apenas atrações mecânicas para o BCW
  const filtered =
    parkId === 319
      ? allRides.filter(r => BCW_MECHANICAL_IDS.includes(r.id))
      : allRides;

  // Normaliza: Title Case nos nomes
  const normalized = filtered.map(r => ({
    ...r,
    name: r.name.replace(/\b\w/g, c => c.toUpperCase()),
  }));

  cache.set(cacheKey, normalized);
  return normalized;
}
