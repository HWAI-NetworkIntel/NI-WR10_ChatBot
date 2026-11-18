# Network Impact Prediction API

Backend API for evaluating provider network changes and comparing a network with competitors. The prediction algorithm is supplied by a separate team and plugs into `services/networkImpactService.js`.

## Routes

- `GET /health`: process health check.
- `POST /api/network-impact/predict`: accepts a JSON object and passes it to the prediction service. It returns `501 ALGORITHM_NOT_CONFIGURED` until the algorithm is connected.

The request body is passed through as JSON until the algorithm contract is finalized. The controller returns the service result directly. Errors use `{ "error": { "code", "message" } }` and unexpected failures do not expose internal details.

## Run

Use Node.js 20 or newer. Configure `PORT` and `ALLOWED_ORIGIN` in `.env`.

```sh
npm install
npm start
```

Run `npm run dev` to restart on file changes.
