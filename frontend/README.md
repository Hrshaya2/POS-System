# Loyal Mobile - POS Management System

A robust, offline-first Point of Sale (POS) system tailored for mobile phone retail and repair shops. This system ensures seamless business continuity by operating locally on a SQLite database and automatically syncing to a cloud MongoDB instance whenever internet connectivity is restored.

---

## 🚀 Key Features

### 1. Offline-First Architecture & Sync Structure
- **Local Persistence:** All transactions, inventory changes, and repair tracking happen instantly on a local SQLite database, resulting in a zero-latency workflow.
- **Cloud Auto-Sync:** A dedicated background worker automatically pushes newly inserted or updated local records (Sales, Inventory, Repairs, Sessions) to MongoDB Atlas when an internet connection establishes, ensuring cloud backup without interrupting the cashier.

### 2. Daily Cash Session Management
- **Shift Enforcement:** Cashiers **cannot** perform sales or access POS features until an official "Day Session" is opened by declaring the starting Cash Drawer and Reload Machine balances.
- **Dynamic Cash Tracking:** As the shift progresses, the system accounts for all cash sales and computes the "Reloads Sold" (Opening Reload - Actual Reload). 
- **Z-Report & Blind Checkout:** At the end of the shift, cashiers are prompted to input the physical cash counted. The system instantly processes Overage, Shortage, or Balanced status by resolving their declaration against expected sales and reloads.

### 3. Role-Based Access Control (RBAC)
- **Shop Owners & Admins:** Full system authority. Can modify user permissions, bypass maximum discount triggers, and access the high-level reporting screens to view profit margins and dead capital.
- **Cashiers:** Restricted to operating the Sales cart, Repairs intake, and their own shift. Blocked from evaluating past Cashier variance records and shop profit margins. Discounts beyond the store limit (e.g., >10%) trigger an **Admin Approval Flag**.

### 4. Advanced Point of Sale (Billing)
- **Smart Catalog Search:** Scan barcodes (SKU) or IMEI numbers, or just type accessory names to add items to the cart instantly.
- **Multi-Tender Payments:** Supports Cash, Card, Bank Transfer, or Split payments natively. Auto-calculates cash change required for exact tender input.
- **Instant Receipt Generation:** Prints clean markup-based receipts mapping out the active transaction, cashier details, and payment specifics in POS thermal printer formats.

### 5. Dual Inventory Tracking
- **IMEI Serial Tracking (Phones):** Locks high-value items individually. Prevents double-selling by associating strict In-Stock/Sold statuses per product serial.
- **Quantity Tracking (Accessories):** Manages cables, covers, and bulk electronics via SKUs and fast decrementing logic.

### 6. Repair Job Management System
- **Status Workflows:** Tracks repair states linearly: `Received` → `In Repair` → `Ready for Pickup` → `Delivered`.
- **Cost Separation:** Distinguishes internal Part Costs from external Labor Cost estimates for accurate profit measuring on repairs natively on the Dashboard.

### 7. Analytical Reporting & Dashboards
- **Dead Stock Warning:** Actively warns administrators regarding inventory items (like phones) that have failed to sell over 30/60/90 days to prevent trapped capital lockups.
- **Turnaround Averages:** Monitors the metric lifecycle in days of how fast the workshop resolves internal phone repairs.
- **Cashier Performance:** Aggregates top-performing cashiers by Total Revenue generated to monitor performance reliably.

---

## 🛠 Tech Stack

- **Frontend:** React, React Router, Vite, Tailwind CSS, Lucide Icons, Recharts (Data Visualization).
- **Backend Node Server:** Express.js, JSON Web Tokens (Auth).
- **Database Architecture:** SQLite3 (Local Primary Offline), MongoDB (Cloud Secondary).

## 📦 Getting Started

1. **Install Dependencies:**
   - In `/backend`: run `npm install`
   - In `/frontend`: run `npm install`

2. **Environment Variables:**
   - Put your offline JWT Secret and Remote Mongo Configuration in `/backend/.env`.

3. **Start the Systems:**
   - Run the Backend Server: `node index.js` inside `/backend`
   - Run the React Interface: `npm run dev` inside `/frontend`

4. Navigate to `http://localhost:5173` to access the application!
