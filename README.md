# GoRide local prototype

This is a small, dependency-free web app with a Node.js API and a local SQLite database.

## Run it

Requires Node.js 22 or newer. From this folder, run:

```sh
npm start
```

Then open <http://127.0.0.1:3000>. The SQLite database is created automatically at `data/goride.sqlite`.

## Current flows

- A 7-digit Maldives phone number requests a six-digit OTP.
- In development mode, the OTP is shown in the UI and logged in the server terminal. No SMS is sent yet.
- Verifying the code creates a user record and a 30-day session.
- Ride requests require that session and are saved with the pickup, destination, ride type, estimate, status, and timestamp.
- English and Dhivehi interface copy is included; the Dhivehi wording is a draft for local review.

## API

- `GET /api/health`
- `POST /api/auth/request-otp` with `{ "phone": "1234567" }`
- `POST /api/auth/verify-otp` with `{ "phone": "1234567", "otp": "123456" }`
- `GET /api/auth/me` with a Bearer session token
- `GET /api/rides` with a Bearer session token
- `POST /api/rides` with a Bearer session token and `{ "pickup": "...", "destination": "...", "rideType": "GoRide" }`

Real SMS delivery is not connected. Before deployment, add an SMS provider, set a strong `OTP_SECRET`, and configure production hosting, HTTPS, and operational protections.
