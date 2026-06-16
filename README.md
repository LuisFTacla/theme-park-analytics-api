[README-theme-park-analytics-api.md](https://github.com/user-attachments/files/29015341/README-theme-park-analytics-api.md)
# 🎢 Theme Park Analytics — API

<div align="center">

![Node.js](https://img.shields.io/badge/Node.js-20.x-339933?style=for-the-badge&logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.x-000000?style=for-the-badge&logo=express&logoColor=white)
![BigQuery](https://img.shields.io/badge/BigQuery-Google-4285F4?style=for-the-badge&logo=google-cloud&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-ef233c?style=for-the-badge)

**PT-BR** | [English below ↓](#-theme-park-analytics--api-1)

REST API que alimenta o [Theme Park Analytics](https://github.com/LuisFTacla/theme-park-analytics) com dados históricos e em tempo real de tempos de espera em parques temáticos ao redor do mundo.

</div>

---

## 📋 Índice

- [Visão Geral](#visão-geral)
- [Arquitetura](#arquitetura)
- [Endpoints](#endpoints)
- [Configuração Local](#configuração-local)
- [Variáveis de Ambiente](#variáveis-de-ambiente)
- [Cache & Performance](#cache--performance)

---

## Visão Geral

Esta API REST serve como camada de dados para o front-end do projeto, desacoplando a lógica de consulta ao **Google BigQuery** da camada de visualização. Ela abstrai queries complexas em endpoints simples, aplica cache em memória para minimizar custos e latência, e normaliza os dados antes de entregá-los ao cliente.

---

## Arquitetura

```
Queue-Times.com API
        │
        ▼
  AWS Lambda (ETL)
        │  coleta a cada N minutos
        ▼
 Google BigQuery ──────────────────────────────┐
  (warehouse histórico)                         │
        │                                       │
        ▼                                       ▼
  theme-park-analytics-api          live.service.ts
   (bigquery.service.ts)         (fallback via Queue-Times)
        │
        ▼
  theme-park-analytics (React)
```

---

## Endpoints

Todos os endpoints retornam `{ data: T, timestamp: string }`.

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET` | `/health` | Health check da API |
| `GET` | `/api/parks` | Lista todos os parques disponíveis |
| `GET` | `/api/parks/:parkId/timezone` | Retorna o fuso horário do parque |
| `GET` | `/api/parks/:parkId/hourly` | Médias históricas de espera por hora do dia, por atração |
| `GET` | `/api/parks/:parkId/calendar` | Médias diárias de lotação (dados para o calendário anual) |
| `GET` | `/api/parks/:parkId/heatmap?date=YYYY-MM-DD&interval=60` | Heatmap de atrações para um dia específico (`interval`: 15, 30 ou 60 min) |
| `GET` | `/api/parks/:parkId/evolution?date=YYYY-MM-DD` | Evolução minuto a minuto da fila geral em um dia |
| `GET` | `/api/parks/:parkId/live` | Dados ao vivo: status e tempo de espera atual por atração |

### Exemplo de resposta — `/api/parks/319/live`

```json
{
  "data": [
    { "id": 11329, "name": "Big Drop", "is_open": true, "wait_time": 45 },
    { "id": 11366, "name": "Crazy River", "is_open": true, "wait_time": 20 },
    { "id": 11332, "name": "Montanha Russa", "is_open": false, "wait_time": 0 }
  ],
  "timestamp": "2026-06-16T14:32:00.000Z"
}
```

---

## Configuração Local

### Pré-requisitos

- Node.js 20+
- Conta no Google Cloud com BigQuery habilitado
- Credenciais de serviço do GCP (JSON)

### Instalação

```bash
# Clone o repositório
git clone https://github.com/LuisFTacla/theme-park-analytics-api.git
cd theme-park-analytics-api

# Instale as dependências
npm install

# Configure as variáveis de ambiente
cp .env.example .env
# Edite o .env com suas credenciais

# Inicie em modo desenvolvimento
npm run dev

# Build para produção
npm run build
npm start
```

---

## Variáveis de Ambiente

Crie um arquivo `.env` na raiz do projeto:

```env
# Porta da API (padrão: 3001)
PORT=3001

# Credenciais do Google BigQuery em Base64
# Como gerar: base64 -i sua-chave-de-servico.json
BQ_CREDENTIALS_BASE64=eyJwcm9qZWN...

# Alternativa: path para o arquivo de credenciais (ADC)
# GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

> **Nota:** As duas formas de autenticação são mutuamente exclusivas. `BQ_CREDENTIALS_BASE64` tem prioridade.

---

## Cache & Performance

A API utiliza **cache em memória** (`node-cache`) com TTLs calibrados por tipo de dado:

| Endpoint | TTL | Justificativa |
|----------|-----|---------------|
| `/parks` | 24h | Lista de parques muda raramente |
| `/hourly` | 1h | Médias históricas são estáveis |
| `/calendar` | 1h | Médias diárias são estáveis |
| `/heatmap` (dia passado) | 1h | Dado imutável |
| `/heatmap` (hoje) | 2min | Atualiza com frequência |
| `/evolution` (hoje) | 2min | Atualiza com frequência |
| `/live` | 2min | Dado em tempo real |

O rate limit é de **60 requisições por IP por minuto**.

---

## 🗂️ Estrutura do Projeto

```
theme-park-analytics-api/
├── src/
│   ├── index.ts                  # Entry point, middlewares
│   ├── routes/
│   │   └── index.ts              # Definição de todos os endpoints
│   ├── services/
│   │   ├── bigquery.service.ts   # Queries ao BigQuery + cache
│   │   └── live.service.ts       # Dados ao vivo via Queue-Times API
│   └── types/
│       └── index.ts              # Interfaces, tipos e constantes
├── dist/                         # Build compilado (gerado)
├── tsconfig.json
├── package.json
└── .env.example
```

---

<br />
<br />

---

# 🎢 Theme Park Analytics — API

<div align="center">

![Node.js](https://img.shields.io/badge/Node.js-20.x-339933?style=for-the-badge&logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.x-000000?style=for-the-badge&logo=express&logoColor=white)
![BigQuery](https://img.shields.io/badge/BigQuery-Google-4285F4?style=for-the-badge&logo=google-cloud&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-ef233c?style=for-the-badge)

[PT-BR acima ↑](#-theme-park-analytics--api) | **English**

REST API powering [Theme Park Analytics](https://github.com/LuisFTacla/theme-park-analytics) with historical and real-time queue wait data from theme parks worldwide.

</div>

---

## 📋 Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Endpoints](#endpoints-1)
- [Local Setup](#local-setup)
- [Environment Variables](#environment-variables)
- [Cache & Performance](#cache--performance-1)

---

## Overview

This REST API serves as the data layer for the front-end application, decoupling **Google BigQuery** query logic from the visualization layer. It abstracts complex queries into simple endpoints, applies in-memory caching to minimize costs and latency, and normalizes data before delivering it to the client.

---

## Architecture

```
Queue-Times.com API
        │
        ▼
  AWS Lambda (ETL)
        │  collects every N minutes
        ▼
 Google BigQuery ──────────────────────────────┐
  (historical warehouse)                        │
        │                                       │
        ▼                                       ▼
  theme-park-analytics-api          live.service.ts
   (bigquery.service.ts)         (fallback via Queue-Times)
        │
        ▼
  theme-park-analytics (React)
```

---

## Endpoints

All endpoints return `{ data: T, timestamp: string }`.

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/health` | API health check |
| `GET` | `/api/parks` | List all available parks |
| `GET` | `/api/parks/:parkId/timezone` | Returns the park's timezone |
| `GET` | `/api/parks/:parkId/hourly` | Historical average wait times by hour of day, per ride |
| `GET` | `/api/parks/:parkId/calendar` | Daily crowd averages (data for the annual calendar) |
| `GET` | `/api/parks/:parkId/heatmap?date=YYYY-MM-DD&interval=60` | Ride heatmap for a specific day (`interval`: 15, 30, or 60 min) |
| `GET` | `/api/parks/:parkId/evolution?date=YYYY-MM-DD` | Minute-by-minute general queue evolution for a day |
| `GET` | `/api/parks/:parkId/live` | Live data: current status and wait time per ride |

### Sample response — `/api/parks/319/live`

```json
{
  "data": [
    { "id": 11329, "name": "Big Drop", "is_open": true, "wait_time": 45 },
    { "id": 11366, "name": "Crazy River", "is_open": true, "wait_time": 20 },
    { "id": 11332, "name": "Montanha Russa", "is_open": false, "wait_time": 0 }
  ],
  "timestamp": "2026-06-16T14:32:00.000Z"
}
```

---

## Local Setup

### Prerequisites

- Node.js 20+
- Google Cloud account with BigQuery enabled
- GCP service account credentials (JSON)

### Installation

```bash
# Clone the repository
git clone https://github.com/LuisFTacla/theme-park-analytics-api.git
cd theme-park-analytics-api

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your credentials

# Start in development mode
npm run dev

# Production build
npm run build
npm start
```

---

## Environment Variables

Create a `.env` file at the project root:

```env
# API port (default: 3001)
PORT=3001

# Google BigQuery credentials as Base64
# How to generate: base64 -i your-service-account.json
BQ_CREDENTIALS_BASE64=eyJwcm9qZWN...

# Alternative: path to credentials file (ADC)
# GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

> **Note:** The two auth methods are mutually exclusive. `BQ_CREDENTIALS_BASE64` takes priority.

---

## Cache & Performance

The API uses **in-memory caching** (`node-cache`) with TTLs calibrated per data type:

| Endpoint | TTL | Reason |
|----------|-----|--------|
| `/parks` | 24h | Park list rarely changes |
| `/hourly` | 1h | Historical averages are stable |
| `/calendar` | 1h | Daily averages are stable |
| `/heatmap` (past day) | 1h | Immutable data |
| `/heatmap` (today) | 2min | Updates frequently |
| `/evolution` (today) | 2min | Updates frequently |
| `/live` | 2min | Real-time data |

Rate limit: **60 requests per IP per minute**.

---

## 🗂️ Project Structure

```
theme-park-analytics-api/
├── src/
│   ├── index.ts                  # Entry point, middlewares
│   ├── routes/
│   │   └── index.ts              # All endpoint definitions
│   ├── services/
│   │   ├── bigquery.service.ts   # BigQuery queries + cache
│   │   └── live.service.ts       # Live data via Queue-Times API
│   └── types/
│       └── index.ts              # Interfaces, types and constants
├── dist/                         # Compiled build (generated)
├── tsconfig.json
├── package.json
└── .env.example
```

---

<div align="center">
  <sub>Built by <a href="https://www.linkedin.com/in/luis-fernando-melnek-tacla/">Luis Fernando Melnek Tacla</a> · Powered by Queue-Times.com · Google BigQuery · AWS Lambda</sub>
</div>
