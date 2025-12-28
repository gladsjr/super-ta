# TA-Assignment MVP

## Overview
A teaching assistant assignment evaluation application that uses OpenAI to conduct an interactive interview with students about their submitted work, then generates an evaluation score.

## Project Structure
- `server.js` - Express server with all API endpoints
- `static/index.html` - Frontend HTML/JS interface
- `config/` - Configuration files (assignment, rubric, system prompt)
- `data/submissions/` - Directory for uploaded student files

## Environment Variables
- `OPENAI_API_KEY` - Required for OpenAI chat functionality
- `PORT` - Server port (defaults to 5000)

## API Endpoints
- `GET /` - Serves the main HTML interface
- `POST /session` - Creates a new evaluation session
- `POST /upload?session=<id>` - Uploads student file for evaluation
- `POST /chat?session=<id>` - Sends message to AI assistant
- `POST /finalize?session=<id>` - Generates final evaluation score

## Running the Application
```bash
npm run dev
```

## Recent Changes
- 2025-12-28: Configured for Replit environment (port 5000, host 0.0.0.0)
