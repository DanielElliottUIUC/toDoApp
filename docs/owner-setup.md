# Owner setup checklist

What the owner does by hand, once, so the build can continue without stopping. Each item ends with a value placed in the local `.env` file (never in chat, never committed). Entry names match `.env.example`.

Written on 2026-11-18. Everything here is free unless it says otherwise.

## Part A: needed to continue the foundation and the intake step

Do these six. With them in place, the rest of step 2 (sign-in, the every-minute tick, the first job) and step 3 (email intake, the Telegram bot) can be built and deployed without further accounts.

### 1. A domain, managed in Cloudflare

Passkeys are tied to the domain permanently, the intake email addresses live on it, and sign-in codes are sent from it.

1. Choose the domain and buy it. Buying it through Cloudflare Registrar is simplest because step 2 is then already done; any registrar works.
2. If it was bought elsewhere: in the Cloudflare dashboard choose "Add a domain", then set the two nameservers Cloudflare gives you at the registrar.
3. Put the bare domain in `.env`:

```
APP_DOMAIN=example.com
```

Cost: the domain itself, as the brief expects.

### 2. A Cloudflare API token

Lets the tick and the email intake be deployed, and the DNS records for mail be created.

1. Cloudflare dashboard > My Profile > API Tokens > Create Token.
2. Start from the "Edit Cloudflare Workers" template.
3. Add two more permissions for the zone of your domain: **DNS: Edit** and **Email Routing Rules: Edit**. Add **Email Routing Addresses: Edit** for the account.
4. Limit the token to your one account and your one domain.
5. Put the token and the account id (shown on the domain's overview page) in `.env`:

```
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_ACCOUNT_ID=
```

### 3. Supabase: plan, database connection, access token

1. Check the project is on the **Pro** plan (the $25 a month in the brief). Session limits and the sign-up hook need it.
2. Database connection: in the project, press **Connect** and copy the **Session pooler** connection string, with the database password filled in.
3. Access token: Account > Access Tokens > Generate new token. This lets the sign-in settings listed under "Permissions" below be set without you clicking through them.
4. Put both in `.env`:

```
SUPABASE_DB_URL=
SUPABASE_ACCESS_TOKEN=
```

### 4. Trigger.dev

1. Open the project. In its API keys page copy the **production** secret key into `TRIGGER_SECRET_KEY` (replace the value there if it is a development key).
2. Copy the project reference (it starts `proj_`) from the project settings.
3. Profile > Personal Access Tokens > create one. This lets the job be deployed.

```
TRIGGER_SECRET_KEY=
TRIGGER_PROJECT_REF=
TRIGGER_ACCESS_TOKEN=
```

### 5. A mail sender for sign-in codes

Supabase's built-in email sends two messages an hour and only to you, so sign-in needs its own sender. Resend's free plan (3,000 emails a month, 100 a day) is far more than this group needs.

1. Create an account at resend.com.
2. Create an API key with sending access.
3. Put it in `.env`. The DNS records that prove the domain is yours are created for you through the Cloudflare token.

```
RESEND_API_KEY=
```

### 6. A Telegram bot

1. In Telegram, open a chat with **@BotFather** and send `/newbot`.
2. Give it a display name and a username ending in `bot`.
3. Put the token it replies with in `.env`:

```
TELEGRAM_BOT_TOKEN=
```

### When the six are done

Say so in chat. The first thing run is one command, which applies the schema to the hosted database, gives the two app database roles their logins, writes their connection strings into `.env` and checks that both roles behave as the design requires:

```
node --env-file=.env scripts/setup-database.mjs
```

It prints what it did and never a password, key or connection string. It is safe to run again.

## Part B: can wait

Neither blocks building. Both are needed before the app holds anyone's real data or is opened daily.

### 7. AWS, for the key service (before any real data)

Until this exists the app runs on a local stand-in key, which is fine for synthetic data and refuses to start in production. Written steps for creating the key and its two restricted credentials will be added here when it is time. Cost: about $1.21 a month.

```
AWS_KMS_KEY_ID=
AWS_REGION=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
```

### 8. Web hosting (before the desktop app, step 4)

A free Vercel account connected to the GitHub repository. Steps will be added here when the desktop app is ready to deploy.

## Permissions

These change things outside this repository. Each needs a plain yes from the owner in chat before it is done the first time.

| Action | Where | Can it be undone |
|---|---|---|
| Apply the database schema | Hosted Supabase project | Yes, while it holds no real data: the tables can be dropped |
| Set login passwords for the two app database roles, and write them to `.env` | Hosted Supabase project | Yes |
| Turn sign-up off, turn passkeys on, register the sign-up hook, set the mail sender and the sign-in code email | Supabase Auth settings | Yes, each is a switch |
| Create the DNS records for mail sending and email intake | The domain in Cloudflare | Yes |
| Deploy the every-minute tick and the email intake | Cloudflare Workers | Yes |
| Deploy the job runner task | Trigger.dev | Yes |
| Point the Telegram bot at the app | Telegram | Yes |
| Create the owner's own account as the first user | Hosted Supabase project | Yes |

Not covered by any of these, and always asked separately: anything that spends money beyond the brief, anything that sends a message to another person, and anything that cannot be undone.

## After Part A

Still to come from the owner, as each step reaches it:

- The hands-on phone and mailbox tests at the end of spikes 4, 5, 6, 7 and 9.
- Forwarding 30 to 50 of his own emails for extraction tuning (intake step).
- The owner's own Anthropic API key, entered in the app's settings page once it exists.
