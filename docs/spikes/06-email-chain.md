# Spike 6: Email chain

Date: 2026-11-17. Method: read Google's, Microsoft's, Cloudflare's and the University of Illinois's published documentation. No mailbox was touched and no mail was sent.

## Question

How does Gmail's forwarding confirmation work, what does the school allow for forwarding to an outside address, and what survives two forwards?

## What was tried

Read Google's forwarding help and Gmail API forwarding guide; Microsoft's pages on external forwarding controls, inbox rules, sender rewriting and loop prevention; Cloudflare's Email Service pages (routing, limits, postmaster, Worker handler); and the University of Illinois Technology Services knowledge base. The Cloudflare rejection rule was re-read by a second reader.

**Assumption:** the school is the University of Illinois Urbana-Champaign. This comes from the repository's account name, not from the owner. If it is wrong, the school findings below do not apply.

## Result

**Gmail's forwarding confirmation**

- Adding a forwarding address makes Google send a verification message to that address. Forwarding starts only after it is confirmed. A filter that forwards can only pick an address that has been verified this way.
- Google does not document the message itself. From archived real samples and other developers' parsers: it comes from `forwarding-noreply@google.com`, the subject contains "Gmail Forwarding Confirmation - Receive Mail from" and the requesting address, and the body carries a confirmation code, a confirm link and a **cancel link**. The samples are old and the format is not guaranteed.
- How long the code or link stays valid is not published.
- Account-level forwarding sends all new mail except spam. Whether filter forwarding skips spam is not stated.
- One developer's live test found Gmail's automatic forwards keep the original sender, date, subject and message id, keep the original signature valid, and add `X-Forwarded-For` and `X-Forwarded-To`.

**The school**

- Microsoft 365 lets an organisation block automatic forwarding to outside addresses, and new tenants block it by default. When it is blocked, the bounce goes to the original sender, so the person who set up the rule sees nothing.
- The University of Illinois publishes its rule. **Students may redirect** university mail to an outside address, by setting the mail field in the university's directory editor and adding an Outlook rule that uses "Redirect to". **Faculty and staff may not**, since October 2021. The knowledge base does not say how a student with a campus job is treated.
- The university's own cautions: redirected mail may be wrongly blocked as spam, mail from other university Exchange users needs the Outlook rule as well as the directory setting, forwarding problems are not supported, and a privacy-law warning applies to university records.
- In Outlook, "Redirect" keeps the original sender; "Forward" makes the message appear to come from the mailbox owner and moves the original sender into the body.

**What survives two forwards (school Outlook, then Gmail, then the app)**

- By automatic rules at both hops, the visible sender, date, subject, message id, body and attachments should arrive unchanged; only the hidden envelope sender is rewritten at each hop. This is assembled from each vendor's description of its own hop. Nobody has documented the two-hop chain end to end, and nothing documents whether calendar invites and inline images survive it.
- By hand ("Forward" at either hop), the message is a new one from the forwarder. The original sender, date and subject exist only as text in the body.
- "Forward as attachment" carries the original intact, headers included.
- Exchange lets an inbox rule automatically forward a given message once; a second automatic hop inside Exchange is silently dropped.

**Cloudflare Email Routing**

- Free, inbound unlimited, 25 MiB per message, catch-all address supported and can go straight to a Worker, so one rule serves every person's address.
- **Cloudflare rejects some mail before the app ever sees it.** Mail that fails both SPF and DKIM is rejected, and so is mail that fails the claimed sender's DMARC policy. Cloudflare itself notes that restrictive DMARC policies can make forwarded mail fail. In practice: an automatic forward of a message from a strict sender (a bank, a government office) whose signature did not survive is dropped, with no trace on the app's side.
- The Worker gets the envelope recipient, the headers and the raw message. On the free plan it has 10 ms of processor time, which Cloudflare warns may not be enough to parse a complex message.
- The domain's DNS must be on Cloudflare and Email Routing takes over the domain's mail records.
- Cloudflare says it does not store message content.

**Why the sender cannot be trusted**

After a manual forward, the authenticated sender is the forwarder and the original "From" is editable text. After an automatic forward, the "From" is proven only when the original signature survived. And anyone who learns an intake address can write to it directly with any "From" they like. The one thing the app can check on every message is the unguessable token in the recipient address.

## Decision

1. Each person's intake address is a long random token on the app's domain, under one catch-all rule. The token is the credential: it is checked, it can be revoked and reissued, and an unknown token is rejected at the Worker.
2. The Worker does no parsing. It checks the token, stores the raw message encrypted, queues it and returns. Parsing happens in the job runner, where there is no 10 ms limit.
3. The sender shown in the staging inbox is labelled as what the message claims, never as verified. No rule trusts a sender.
4. The setup screen watches for Gmail's confirmation message and shows the person its code and confirm link to tap themselves. The app never opens the link, and never shows the cancel link.
5. Setup advice, in order of reliability: a Gmail filter or account-level forward straight to the intake address (one hop); forwarding by hand for one-off items; for school mail, an Outlook "Redirect" rule straight to the intake address where the school allows it. Fewer hops lose less.
6. Messages over 25 MiB and messages Cloudflare rejects never arrive and the app cannot see that they did not. Setup includes a "send a test message" step that confirms the path end to end, and the intake page says plainly that mail from some strict senders may not come through an automatic forward and should be forwarded by hand.
7. The parser handles three shapes: an automatic forward (original headers intact), a manual forward (original details in a quoted block, treated as untrusted text), and a forwarded attachment.

## Needs the owner (hands-on, at the intake step)

None of these blocks the foundation step. Each needs a real mailbox.

1. Confirm the school, and whether the owner's account counts as student or staff for forwarding.
2. Add the intake address as a Gmail forwarding address and record the confirmation message's sender, subject, code format and link, and whether it arrives.
3. Set an Outlook "Redirect" rule on the school account and see whether mail from inside and outside the university arrives.
4. Send five messages through each chain, by rule and by hand: plain text, HTML with an inline image, a PDF attachment, a meeting invite, and one from a strict sender such as a bank. Record what arrives.
5. Check Cloudflare's activity log for forwarded mail that was rejected.

## Still open

- Whether the two-hop automatic chain preserves invites and inline images.
- The share of real forwarded mail that Cloudflare rejects. If it is high for the owner's senders, the remedy is forwarding by hand or a paid mail-receiving service, which would be a new cost to raise then.
