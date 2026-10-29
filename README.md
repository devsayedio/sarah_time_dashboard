# Sarah Time - Admin Dashboard (Node.js)

An enterprise attendance management and policy control dashboard for **Sarah Time**.

## Features
- **Live Attendance Overview**: Real-time stats for Present, Late, Absent, and Checked-out employees based on Dhaka time (`Asia/Dhaka`).
- **Attendance Log**: Full history with search and status filtering (Present, Late, Absent).
- **Employee Directory**: Manage active/inactive status and view complete profiles in a modal drawer.
- **Office & Geofence Policy**: Configure office coordinates (Latitude, Longitude), allowed radius, shift start/end times, and late thresholds.
- **Interactive Map**: Visualizes the office location and geofence boundary using Leaflet.js.
- **Date Overrides**: Add custom holidays or special workdays.
- **Push Notifications**: Send an FCM push to all employees or a selected few, review a filterable and paginated delivery history, and schedule one-time or recurring (daily/weekly/monthly) notifications. Cloudflare Cron dispatches due notifications every five minutes in production.

## Tech Stack
- **Backend**: Node.js, Express, Firebase Admin SDK (Firestore + Cloud Messaging)
- **Frontend**: HTML5, Vanilla CSS (Dark Theme + Glassmorphism), JavaScript (ES6+), Leaflet.js
- **Database**: Cloud Firestore (`employee-attendance-30f81`)

## Running Locally
```bash
npm start
```
The dashboard will be available at `http://localhost:3000`.

> Run only one instance at a time. Each process starts its own scheduled-notification worker, so two instances can dispatch the same scheduled notification twice.

## Deployment
The production dashboard runs on Cloudflare Workers at
<https://sarah-time-dashboard.royalcourtbd.com>. Pushing to the `deployment`
branch deploys it automatically. See [DEPLOYMENT.md](DEPLOYMENT.md).
