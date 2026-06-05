# Hibret Edir Association — Web Platform

Ethiopian Mutual Assistance Program — Greater Los Angeles

## 🌐 Live Sites

| Page | URL |
|------|-----|
| Public Website | hibretedir.com |
| Member Portal | hibretedir.com/portal |
| Board Admin | hibretedir.com/admin |

## 📁 Structure

```
hibretedir/
├── public/
│   ├── index.html          ← Public website (replaces Wix)
│   ├── portal/
│   │   └── index.html      ← Member portal (phone + PIN login)
│   └── admin/
│       └── index.html      ← Board CRM & invoice dashboard
├── netlify/
│   └── functions/          ← Serverless API functions (coming soon)
│       ├── auth.js         ← Member authentication
│       ├── paypal-sync.js  ← PayPal invoice sync
│       └── upload.js       ← Receipt upload handler
├── netlify.toml            ← Netlify configuration
└── README.md               ← This file
```

## 🚀 Deployment

This site is deployed on Netlify with automatic deploys from GitHub.

Every push to `main` branch automatically deploys to production.

## 🔐 Environment Variables

Set these in Netlify Dashboard → Site Settings → Environment Variables:

```
PAYPAL_CLIENT_ID=your_paypal_client_id
PAYPAL_SECRET=your_paypal_secret
DATABASE_URL=your_render_postgres_url
JWT_SECRET=your_random_secret_key
```

## 📱 Features

### Public Website
- Home page with mission and announcements
- How It Works (4-step process)
- About Us with organization history
- Payment methods (PayPal, Zelle, BofA)
- By-Laws summary with PDF download
- Waiting list application form
- Contact form
- English / Amharic language toggle
- Fully mobile responsive

### Member Portal
- Phone number + PIN authentication
- First-time PIN creation
- Outstanding invoices with PayPal payment links
- Days overdue indicators
- Receipt upload for Zelle/BofA payments
- Member profile management
- Beneficiary designation
- Push notifications

### Board Admin (CRM)
- Complete member database (219 members)
- Invoice tracking and management
- Payment status dashboard
- Member detail view and editing
- Event summary reports
- Overview analytics

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | HTML, CSS, JavaScript |
| Hosting | Netlify |
| Database | Render PostgreSQL (coming soon) |
| Auth | Custom PIN + JWT (coming soon) |
| Payments | PayPal API (coming soon) |
| SMS | Twilio (coming soon) |
| Email | SendGrid (coming soon) |

## 📞 Support

- Phone/WhatsApp: (424) 547-5594
- Email: hibretedirtext@gmail.com
- Technical: hibretedirautomation@gmail.com

## 📋 Roadmap

- [x] Public website
- [x] Member portal (frontend)
- [x] Board CRM (frontend)
- [ ] Render PostgreSQL backend
- [ ] Real authentication (PIN hashed)
- [ ] PayPal API sync
- [ ] Receipt upload to cloud storage
- [ ] SMS/WhatsApp notifications via Twilio
- [ ] Automated invoice creation
- [ ] Waiting list automation
- [ ] Annual report generation

---

*Built with ❤️ for the Hibret Edir community — Los Angeles, CA*
