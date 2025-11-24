# Medication Availability & Price Checker

This web app lets users search for a medicine (e.g., “Amoxicillin”), compare estimated prices, and find nearby pharmacies. It integrates external APIs for drug information and pharmacy locations, with secure handling of API keys via environment variables.

## Features
- Search any medication by name (validated via RxNorm).
- Locate nearby pharmacies using Geoapify Places.
- Show pharmacy name, address, distance, and contact info.
- Filtering: location (text + radius), price range, stock.
- Sorting: nearest, lowest price, highest price.
- Clear, responsive UI with helpful error messages.
- Health endpoint (`/health`) for load balancer monitoring.

## External APIs
- RxNorm (NLM/NIH) for drug normalization: https://rxnav.nlm.nih.gov/
- Geoapify for geocoding and places (pharmacies): https://www.geoapify.com/
- Fallback (no key): Nominatim (geocoding) + Overpass API (pharmacies) via OpenStreetMap

Note: Pharmacy prices and stock are simulated estimates for demo purposes. Real retail prices vary between pharmacies and dosage/forms.

## Local Setup
1. Create `.env` from `.env.example` and set:
   ```
   GEOAPIFY_KEY=your_geoapify_key_here
   PORT=3000
   ```
   - If `GEOAPIFY_KEY` is not set, the app falls back to Nominatim + Overpass (rate-limited public endpoints). This enables local testing without a key, but Geoapify is recommended for reliability.
2. Install dependencies:
   - `npm install`
3. Run the app:
   - `npm start`
4. Open: `http://localhost:3000/`

### API Endpoints
- `GET /api/search?med=<name>&location=<text>&radius_km=<n>&price_min=<p>&price_max=<p>&stock=<any|in_stock|low_stock>&sort=<distance|price_asc|price_desc>`
  - Returns normalized med (RxCUI), resolved location, and list of pharmacies with distance, phone, estimated price, and availability.
- `GET /health` → `{ status: "ok" }`

### Error Handling
- Invalid medicine names: returns `400` with spelling suggestions from RxNorm.
- Geocoding failures: returns `404` for unknown locations.
- Upstream API failures: standardized `502` with limited details.
- Frontend shows non-blocking error bar.

## Deployment (Two Servers + Load Balancer)

### Servers: Web01 and Web02
- Prereqs: Node.js 18+, firewall rules for inbound via LB, `.env` with `GEOAPIFY_KEY` and `PORT`.

Steps:
1. SSH into Web01 and Web02.
2. Clone repo and `cd` into folder.
3. Create `.env` with real keys.
4. `npm install`
5. Start app: `npm start` or use PM2: `pm2 start server.js`
6. Verify: `curl http://localhost:3000/health` returns ok.

### Load Balancer (Lb01) – Nginx Example
Create an upstream with both servers and distribute traffic.

`/etc/nginx/sites-available/med-checker`:
```nginx
upstream med_checker_upstream {
    least_conn;
    server <WEB01_PRIVATE_IP>:3000 max_fails=3 fail_timeout=10s;
    server <WEB02_PRIVATE_IP>:3000 max_fails=3 fail_timeout=10s;
}

server {
    listen 80;
    server_name _; # or your domain

    location /health {
        proxy_pass http://med_checker_upstream/health;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
    }

    location / {
        proxy_pass http://med_checker_upstream/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable & reload:
- `sudo ln -s /etc/nginx/sites-available/med-checker /etc/nginx/sites-enabled/med-checker`
- `sudo nginx -t`
- `sudo systemctl reload nginx`

### Testing Distribution & Failover
1. `curl http://Lb01/health` baseline.
2. Watch logs on Web01/Web02; issue requests via `http://Lb01/` and observe distribution.
3. Stop app on Web02 (e.g., `pm2 stop server`) and confirm `http://Lb01/` still serves from Web01.
4. Restart Web02; confirm rebalanced traffic.

### Security Notes
- API keys are stored only in environment variables; never in code.
- Consider HTTPS on Lb01 (Let’s Encrypt).
- Keep Web01/Web02 private and only expose Lb01 publicly if possible.

## Credits
- RxNorm and Geoapify for foundational data.