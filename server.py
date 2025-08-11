import os
import stripe
from flask import Flask, render_template, request, jsonify
import requests
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.application import MIMEApplication
from email.mime.text import MIMEText
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)

# Stripe
stripe.api_key = os.getenv("STRIPE_SECRET_KEY")

# GetResponse
GETRESPONSE_API_KEY = os.getenv("GETRESPONSE_API_KEY")
GETRESPONSE_CAMPAIGN_ID = os.getenv("GETRESPONSE_CAMPAIGN_ID")

# Email (Gmail)
SENDER_EMAIL = os.getenv("SENDER_EMAIL")
SENDER_PASSWORD = os.getenv("SENDER_PASSWORD")

# STRIPE Checkout Session
@app.route("/create-checkout-session", methods=["POST"])
def create_checkout_session():
    data = request.get_json()
    product_name = data.get("product_name")
    customer_email = data.get("email")
    price = data.get("price")  # w centach

    try:
        session = stripe.checkout.Session.create(
            payment_method_types=["card"],
            line_items=[{
                "price_data": {
                    "currency": "eur",
                    "product_data": {"name": product_name},
                    "unit_amount": price
                },
                "quantity": 1
            }],
            mode="payment",
            success_url="http://localhost:5000/success?email=" + customer_email,
            cancel_url="http://localhost:5000/cancel",
            customer_email=customer_email
        )
        return jsonify({"id": session.id})
    except Exception as e:
        return jsonify(error=str(e)), 400

# SUCCESS – GetResponse + Email PDF
@app.route("/success")
def payment_success():
    customer_email = request.args.get("email")

    # Dodaj do GetResponse
    requests.post(
        "https://api.getresponse.com/v3/contacts",
        headers={"X-Auth-Token": f"api-key {GETRESPONSE_API_KEY}"},
        json={
            "name": customer_email.split("@")[0],
            "email": customer_email,
            "campaign": {"campaignId": GETRESPONSE_CAMPAIGN_ID}
        }
    )

    # Wyślij maila z PDF
    send_pdf_email(customer_email)

    return "Zahlung erfolgreich! Plan PDF wurde an Ihre E-Mail versandt."

def send_pdf_email(recipient_email):
    msg = MIMEMultipart()
    msg["From"] = SENDER_EMAIL
    msg["To"] = recipient_email
    msg["Subject"] = "Ihr Trainingsplan"

    # Treść
    body = "Vielen Dank für Ihren Kauf! Im Anhang finden Sie Ihren PDF-Plan."
    msg.attach(MIMEText(body, "plain"))

    # PDF jako załącznik
    with open("static/plany/plan_trainings.pdf", "rb") as f:
        part = MIMEApplication(f.read(), Name="plan_trainings.pdf")
        part["Content-Disposition"] = 'attachment; filename="plan_trainings.pdf"'
        msg.attach(part)

    # SMTP
    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
        server.login(SENDER_EMAIL, SENDER_PASSWORD)
        server.send_message(msg)

if __name__ == "__main__":
    app.run(port=5000, debug=True)
