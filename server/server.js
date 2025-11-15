import express from "express";
import cors from "cors";
import { Pool } from "pg";
import dotenv from "dotenv";
import PDFDocument from "pdfkit";
import dayjs from "dayjs";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

/* ============================================================
   1️⃣ NEW CUSTOMER + FIRST ORDER (FULLY FIXED)
============================================================ */
app.post("/api/new-customer", async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      name,
      phone,
      alt_phone,
      address,
      rent_start,
      rent_end,
      items = [],
      order_date
    } = req.body;

    if (!name || !phone || !address)
      return res.json({ success: false, error: "Missing required fields" });

    if (!items.length)
      return res.json({ success: false, error: "No product items found" });

    await client.query("BEGIN");

    // FIXED: CHECK IF CUSTOMER ALREADY EXISTS
    let cx = await client.query(
      `SELECT id FROM customers WHERE phone=$1`,
      [phone]
    );

    let customerId;

    if (cx.rows.length) {
      // Existing customer → update details (optional)
      customerId = cx.rows[0].id;

      await client.query(
        `UPDATE customers SET name=$1, alt_phone=$2, address=$3 WHERE id=$4`,
        [name, alt_phone || null, address, customerId]
      );

    } else {
      // New customer
      const cust = await client.query(
        `INSERT INTO customers (name, phone, alt_phone, address)
         VALUES ($1,$2,$3,$4)
         RETURNING id`,
        [name, phone, alt_phone || null, address]
      );

      customerId = cust.rows[0].id;
    }

    // Order Date
    const finalOrderDate = order_date || dayjs().format("YYYY-MM-DD");

    // Create Order
    const ord = await client.query(
      `INSERT INTO orders (invoice_no, customer_id, order_date, rent_start, rent_end, total)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id`,
      [
        uuidv4(),
        customerId,
        finalOrderDate,
        rent_start || null,
        rent_end || null,
        0
      ]
    );

    const orderId = ord.rows[0].id;

    // Insert Order Items
    let total = 0;

    for (const it of items) {
      const price = Number(it.price);
      const qty = Number(it.quantity);
      const line = price * qty;
      total += line;

      await client.query(
        `INSERT INTO order_items (order_id, product, price, quantity, line_total)
         VALUES ($1,$2,$3,$4,$5)`,
        [orderId, it.product, price, qty, line]
      );
    }

    // Update Order Total
    await client.query(
      `UPDATE orders SET total=$1 WHERE id=$2`,
      [total, orderId]
    );

    await client.query("COMMIT");

    return res.json({ success: true, customerId, orderId });

  } catch (err) {
    await pool.query("ROLLBACK");
    console.log("🔥 NEW CUSTOMER ERROR:", err);
    return res.json({ success: false, error: err.message });
  }
});



/* ============================================================
   2️⃣ GENERATE BILL (Manual)
============================================================ */
app.post("/api/generate-bill", async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      name,
      phone,
      alt_phone,
      address,
      rent_start,
      rent_end,
      items = []
    } = req.body;

    if (!name || !phone || !address)
      return res.json({ success: false, error: "Missing required fields" });

    if (!items.length)
      return res.json({ success: false, error: "No product items found" });

    await client.query("BEGIN");

    // Check customer
    let c = await client.query(`SELECT id FROM customers WHERE phone=$1`, [phone]);
    let customerId;

    if (c.rows.length) {
      customerId = c.rows[0].id;
    } else {
      const newC = await client.query(
        `INSERT INTO customers (name, phone, alt_phone, address)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [name, phone, alt_phone || null, address]
      );
      customerId = newC.rows[0].id;
    }

    // Create order
    const orderDate = dayjs().format("YYYY-MM-DD");

    const order = await client.query(
      `INSERT INTO orders (invoice_no, customer_id, order_date, rent_start, rent_end, total)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id`,
      [
        uuidv4(),
        customerId,
        orderDate,
        rent_start || null,
        rent_end || null,
        0
      ]
    );

    const orderId = order.rows[0].id;

    let total = 0;

    for (const it of items) {
      const line = Number(it.price) * Number(it.quantity);
      total += line;

      await client.query(
        `INSERT INTO order_items (order_id, product, price, quantity, line_total)
         VALUES ($1,$2,$3,$4,$5)`,
        [orderId, it.product, it.price, it.quantity, line]
      );
    }

    await client.query(
      `UPDATE orders SET total=$1 WHERE id=$2`,
      [total, orderId]
    );

    await client.query("COMMIT");

    return res.json({ success: true, orderId });

  } catch (err) {
    await client.query("ROLLBACK");
    console.log("🔥 Generate bill error:", err);
    return res.json({ success: false, error: err.message });
  }
});



/* ============================================================
   3️⃣ SEARCH CUSTOMERS
============================================================ */
app.get("/api/customers", async (req, res) => {
  try {
    const { q } = req.query;

    let sql = `SELECT id, name, phone, alt_phone, address FROM customers`;
    const params = [];

    if (q) {
      sql += ` WHERE name ILIKE $1 OR phone ILIKE $1`;
      params.push(`%${q}%`);
    }

    sql += ` ORDER BY id DESC`;

    const r = await pool.query(sql, params);

    res.json({ success: true, rows: r.rows });

  } catch (err) {
    return res.json({ success: false });
  }
});



/* ============================================================
   4️⃣ CUSTOMER DETAILS
============================================================ */
app.get("/api/customer-details", async (req, res) => {
  try {
    const { id } = req.query;

    const cust = await pool.query(`SELECT * FROM customers WHERE id=$1`, [id]);

    if (!cust.rows.length)
      return res.json({ success: false });

    const orders = await pool.query(
      `SELECT * FROM orders WHERE customer_id=$1 ORDER BY id DESC`,
      [id]
    );

    const orderDetails = [];

    for (const o of orders.rows) {
      const items = await pool.query(
        `SELECT * FROM order_items WHERE order_id=$1`,
        [o.id]
      );
      orderDetails.push({ order: o, items: items.rows });
    }

    res.json({ success: true, customer: cust.rows[0], orderDetails });

  } catch (err) {
    console.log(err);
    return res.json({ success: false });
  }
});



/* ============================================================
   5️⃣ CUSTOMER ORDERS TABLE
============================================================ */
app.get("/api/customer-orders", async (req, res) => {
  try {
    const { id } = req.query;

    const rows = await pool.query(
      `SELECT id, order_date, rent_start, rent_end, total
       FROM orders
       WHERE customer_id=$1
       ORDER BY id DESC`,
      [id]
    );

    res.json({ success: true, rows: rows.rows });

  } catch (err) {
    return res.json({ success: false });
  }
});


/* ============================================================
   6️⃣ ORDER FULL DETAILS
============================================================ */
app.get("/api/order-full-details", async (req, res) => {
  try {
    const { orderId } = req.query;

    const order = await pool.query(
      `SELECT o.*, c.name AS cname, c.phone AS cphone, c.alt_phone AS caltphone, c.address AS caddress
       FROM orders o
       JOIN customers c ON c.id=o.customer_id
       WHERE o.id=$1 LIMIT 1`,
      [orderId]
    );

    if (!order.rows.length) return res.json({ success: false });

    const items = await pool.query(
      `SELECT * FROM order_items WHERE order_id=$1`,
      [orderId]
    );

    res.json({ success: true, order: order.rows[0], items: items.rows });

  } catch (err) {
    return res.json({ success: false });
  }
});


/* ============================================================
   7️⃣ PDF BILL
============================================================ */
// ======================================================================
// 7️⃣  PDF BILL — FIXED (NO MORE toFixed ERROR)
// ======================================================================
app.get("/api/invoice/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;

    const orderQ = await pool.query(
      `SELECT o.*, 
              c.name AS cname,
              c.phone AS cphone,
              c.address AS caddress
       FROM orders o
       JOIN customers c ON o.customer_id = c.id
       WHERE o.id=$1 LIMIT 1`,
      [orderId]
    );

    if (!orderQ.rows.length)
      return res.status(404).send("Order not found");

    const order = orderQ.rows[0];

    const itemsQ = await pool.query(
      `SELECT * FROM order_items WHERE order_id=$1`,
      [orderId]
    );

    // PDF
    const doc = new PDFDocument({ size: "A4", margin: 40 });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "inline; filename=bill.pdf");

    doc.pipe(res);

    const teal = "#006666";

    // HEADER
    doc.fontSize(12).fillColor(teal).text("9916067960, 8073024022", 40, 30);
    doc.fontSize(26).fillColor(teal).text("SUBRAMANI ENTERPRISES", 0, 60, { align: "center" });

    // CUSTOMER INFO CENTER
    let cy = 130;
    doc.font("Helvetica").fontSize(12).fillColor("#000");
    doc.text(`DATE: ${dayjs(order.order_date).format("DD/MM/YYYY")}`, 0, cy, { align: "center" }); cy += 25;
    doc.text(`CUSTOMER NAME: ${order.cname}`, 0, cy, { align: "center" }); cy += 25;
    doc.text(`PHONE: ${order.cphone}`, 0, cy, { align: "center" }); cy += 25;
    doc.text(`ADDRESS: ${order.caddress}`, 0, cy, { align: "center" });

    // TABLE HEADER
    let tableTop = doc.y + 30;

    doc.font("Helvetica-Bold").fontSize(11).fillColor(teal);
    doc.text("DESCRIPTION", 40, tableTop);
    doc.text("PRICE", 260, tableTop);
    doc.text("QTY", 350, tableTop);
    doc.text("AMOUNT", 450, tableTop);

    doc.moveTo(40, tableTop + 15).lineTo(550, tableTop + 15).strokeColor(teal).stroke();

    // TABLE ROWS
    doc.font("Helvetica").fontSize(10).fillColor("#000");
    let y = tableTop + 25;
    let grand = 0;

    itemsQ.rows.forEach(it => {
      // FIX → Ensure values are valid numbers
      const price = Number(it.price) || 0;
      const qty = Number(it.quantity) || 0;
      const amount = Number(it.line_total) || (price * qty) || 0;

      doc.text(it.product, 40, y);
      doc.text(price.toFixed(2), 260, y);
      doc.text(qty.toString(), 350, y);
      doc.text(amount.toFixed(2), 450, y);

      grand += amount;
      y += 22;

      doc.moveTo(40, y).lineTo(550, y).strokeColor("#ddd").stroke();
    });

    // TOTAL BOX
    y += 30;
    doc.strokeColor(teal).rect(350, y, 200, 50).stroke();

    doc.font("Helvetica-Bold").fontSize(13).fillColor(teal).text("TOTAL", 360, y + 8);
    doc.fontSize(16).fillColor(teal).text(`₹ ${grand.toFixed(2)}`, 360, y + 28);

    // FOOTER
    doc.moveDown(4);
    doc.font("Helvetica").fontSize(10).fillColor(teal)
      .text("5TH CROSS, CANNEL RIGHT SIDE, VENKATESHA NAGAR, SHIMOGA | 577202 | PHONE: 6363499137",
        { align: "center" });

    doc.moveDown(1);
    doc.font("Helvetica-Bold").fontSize(11).fillColor(teal)
      .text("THANK YOU FOR YOUR BUSINESS!", { align: "center" });

    doc.end();

  } catch (err) {
    console.log("🔥 PDF ERROR:", err);
    if (!res.headersSent) {
      res.status(500).send("PDF Error");
    }
  }
});



// ======================================================================
// START SERVER
// ======================================================================
export default app;
