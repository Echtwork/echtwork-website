// server.js
// Backend für echtwork.de — Stripe Checkout + Webhook + E-Mail Versand
const express = require('express');
const fs = require('fs');
const path = require('path');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const { randomUUID } = require('crypto');
require('dotenv').config();

const app = express();

// Konfiguracja z .env
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY; // sk_test_xxx
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET; // whsec_xxx
const DOMAIN = process.env.DOMAIN || 'http://localhost:3000';
const MAIL_USER = process.env.MAIL_USER;
const MAIL_PASS = process.env.MAIL_PASS;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

if (!STRIPE_SECRET) {
  console.error('Fehler: STRIPE_SECRET_KEY fehlt in .env');
  process.exit(1);
}

const stripe = Stripe(STRIPE_SECRET);

// PUBLIC: success/cancel pages (pliki statyczne)
app.use(express.static('public'));

// Important: webhook needs raw body, therefore define webhook route BEFORE express.json()
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed.', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // obsługa zdarzenia checkout.session.completed
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    console.log('Checkout abgeschlossen für session:', session.id);

    const metadata = session.metadata || {};
    const product = metadata.product || null;

    // Standardplan oder Ernährungsplan -> wyślij PDF klientowi
    if (product === 'standardplan' || product === 'ernaehrungsplan') {
      const email = session.customer_details && session.customer_details.email;
      if (email) {
        // wybierz plik PDF wg produktu
        const pdfFile = product === 'standardplan' ? path.join(__dirname, 'plans', 'standardplan.pdf') : path.join(__dirname, 'plans', 'ernaehrungsplan.pdf');

        // Wyślij e-mail z załącznikiem
        const transporter = nodemailer.createTransport({
          host: process.env.MAIL_HOST || 'smtp.example.com',
          port: process.env.MAIL_PORT ? parseInt(process.env.MAIL_PORT) : 465,
          secure: process.env.MAIL_SECURE === 'true', // true dla 465
          auth: { user: MAIL_USER, pass: MAIL_PASS }
        });

        const mailOptions = {
          from: `"Echtwork" <${MAIL_USER}>`,
          to: email,
          subject: `Dein ${product === 'standardplan' ? 'Trainingsplan' : 'Ernährungsplan'} – Echtwork`,
          text: 'Vielen Dank für deinen Kauf! Im Anhang findest du deinen Plan als PDF.',
          attachments: [
            { filename: path.basename(pdfFile), path: pdfFile }
          ]
        };

        transporter.sendMail(mailOptions, (err, info) => {
          if (err) console.error('Fehler beim Senden der Mail:', err);
          else console.log('Mail mit PDF gesendet an', email, info.response);
        });
      }
    }

    // Premium: nie wysyłamy PDF automatycznie; powiadom admina i klienta o otrzymaniu płatności
    if (product === 'premium') {
      const submissionId = metadata.submission_id;
      const email = session.customer_details && session.customer_details.email;

      // Odczytaj zapisane zgłoszenie (jeśli istnieje)
      let submission = null;
      if (submissionId) {
        const file = path.join(__dirname, 'submissions', `${submissionId}.json`);
        if (fs.existsSync(file)) {
          submission = JSON.parse(fs.readFileSync(file, 'utf8'));
        }
      }

      const transporter = nodemailer.createTransport({
        host: process.env.MAIL_HOST || 'smtp.example.com',
        port: process.env.MAIL_PORT ? parseInt(process.env.MAIL_PORT) : 465,
        secure: process.env.MAIL_SECURE === 'true',
        auth: { user: MAIL_USER, pass: MAIL_PASS }
      });

      // Mail do admina: płatność otrzymana + dane zgłoszenia
      const adminMail = {
        from: `"Echtwork" <${MAIL_USER}>`,
        to: ADMIN_EMAIL,
        subject: `Premium Bestellung bezahlt – Submission ${submissionId || '(keine ID)'}`,
        text: `Eine Premium-Bestellung wurde bezahlt.\n\nSession ID: ${session.id}\nKunde: ${session.customer_details && session.customer_details.email}\nSubmission-ID: ${submissionId || 'keine'}\n\nDaten:\n${submission ? JSON.stringify(submission, null, 2) : 'Keine Submission-Datei gefunden.'}`
      };
      transporter.sendMail(adminMail, (err, info) => {
        if (err) console.error('Fehler beim Senden Admin-Mail:', err);
        else console.log('Admin über Zahlung informiert:', info.response);
      });

      // Mail potwierdzający do klienta (bez PDF)
      if (email) {
        const clientMail = {
          from: `"Echtwork" <${MAIL_USER}>`,
          to: email,
          subject: `Zahlung erhalten – Premium Anfrage`,
          text: `Vielen Dank! Wir haben deine Zahlung erhalten. Wir bearbeiten nun deine Anfrage und melden uns innerhalb von 1–5 Werktagen per E-Mail.`
        };
        transporter.sendMail(clientMail, (err, info) => {
          if (err) console.error('Fehler beim Senden Bestätigungs-Mail an Kunde:', err);
          else console.log('Bestätigungs-Mail an Kunde gesendet:', info.response);
        });
      }
    }
  }

  res.json({ received: true });
});

// Dalsze middleware (JSON body parsers) dla tworzenia sesji itd.
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Utwórz checkout session dla Standard i Ernährungsplan
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { product, training, bundle } = req.body;
    let unitAmount;
    let description;
    const metadata = {};

    if (product === 'standardplan') {
      unitAmount = bundle ? 7000 : 6000; // centy
      description = `Standardplan - ${training}${bundle ? ' + Ernährungsplan' : ''}`;
      metadata.product = 'standardplan';
      metadata.training = training || '';
      metadata.bundle = bundle ? 'yes' : 'no';
    } else if (product === 'ernaehrungsplan') {
      unitAmount = 2500; // 25 €
      description = 'Ernährungsplan';
      metadata.product = 'ernaehrungsplan';
    } else {
      return res.status(400).json({ error: 'Ungültiges Produkt' });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'eur',
            product_data: { name: description },
            unit_amount: unitAmount
          },
          quantity: 1
        }
      ],
      mode: 'payment',
      metadata,
      success_url: `${DOMAIN}/success.html`,
      cancel_url: `${DOMAIN}/cancel.html`
    });

    res.json({ id: session.id });
  } catch (err) {
    console.error('Fehler create-checkout-session:', err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// Endpoint: otrzymujemy formularz premium -> zapis, mail do admina (oznaczenie "zahlung ausstehend"), tworzymy Checkout Session
app.post('/create-checkout-session-premium', async (req, res) => {
  try {
    const { name, email, ziele, gesundheit, wuensche } = req.body;
    // walidacja minimalna
    if (!name || !email || !ziele) return res.status(400).json({ error: 'Name, E-Mail und Ziele sind erforderlich.' });

    // zapisz submission jako JSON z unikalnym ID
    const id = randomUUID();
    const submissionsDir = path.join(__dirname, 'submissions');
    if (!fs.existsSync(submissionsDir)) fs.mkdirSync(submissionsDir, { recursive: true });

    const submission = { id, name, email, ziele, gesundheit, wuensche, createdAt: new Date().toISOString() };
    fs.writeFileSync(path.join(submissionsDir, `${id}.json`), JSON.stringify(submission, null, 2), 'utf8');

    // wyślij mail do admina: nowe zgłoszenie (płatność oczekiwana)
    const transporter = nodemailer.createTransport({
      host: process.env.MAIL_HOST || 'smtp.example.com',
      port: process.env.MAIL_PORT ? parseInt(process.env.MAIL_PORT) : 465,
      secure: process.env.MAIL_SECURE === 'true',
      auth: { user: MAIL_USER, pass: MAIL_PASS }
    });

    const adminMail = {
      from: `"Echtwork" <${MAIL_USER}>`,
      to: ADMIN_EMAIL,
      subject: `Neue Premium-Anfrage (Zahlung ausstehend) – ${name}`,
      text: `Neue Premium-Anfrage:\n\nID: ${id}\nName: ${name}\nE-Mail: ${email}\nZiele: ${ziele}\nGesundheit: ${gesundheit}\nWünsche: ${wuensche}\n\nDie Zahlung steht noch aus.`
    };
    transporter.sendMail(adminMail, (err, info) => {
      if (err) console.error('Fehler beim Senden Admin-Mail (vor Zahlung):', err);
      else console.log('Admin informiert über neue Premium-Anfrage:', info.response);
    });

    // utwórz Stripe Checkout session dla premium (z metadata submission_id)
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: `Premium Individuell – ${name}` },
          unit_amount: 9900 // 99 €
        },
        quantity: 1
      }],
      mode: 'payment',
      metadata: { product: 'premium', submission_id: id },
      customer_email: email,
      success_url: `${DOMAIN}/success.html`,
      cancel_url: `${DOMAIN}/cancel.html`
    });

    res.json({ id: session.id });
  } catch (err) {
    console.error('Fehler create-checkout-session-premium:', err);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
