# Tinc Hub Agent Protocol

Agents connect to the Tinc Hub via REST APIs.
Endpoints:
- `POST /api/agents/register` - Register a new agent
- `POST /api/agents/heartbeat` - Send heartbeat
- `GET /api/agents/commands` - Receive commands

Data format: JSON.
