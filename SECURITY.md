# Pro Aid · how the app is protected

**Who can do what is decided in the database, not in the app.** Every table has row-level security; every rule
(photo required, no duplicate payment, day locked after approval, staff cannot edit, owner needs a reason) is a
database trigger or function. A modified app, a script with the public key, or the Supabase REST API all hit the same rules.

- Sign-in: phone + 6-digit PIN. The PIN is never stored or sent as-is — the app derives a SHA-256 password from
  phone + PIN + app salt, and Supabase Auth stores a bcrypt hash of that. Five wrong PINs → 60 s wait in the app;
  Supabase also rate-limits sign-in attempts per IP.
- Sessions lock after 15 minutes without a touch. Anyone can change their own PIN (current PIN required);
  the owner can reset a PIN from Settings — every reset is in the audit log.
- The public "anon" key can only call `setup_needed()` (and first-owner setup while no profile exists). Every other
  function and table needs a signed-in, active user with a role.
- Notifications are created by the system only — a user cannot forge an owner alert through the API.
- Photos: private bucket; a user can upload only into their own folder; nothing in the bucket can be changed or
  deleted through the API; each photo is proof for exactly one entry.
- The published app carries a Content-Security-Policy: scripts only from the app itself, network only to Supabase,
  no plugins; fonts are self-hosted, no third-party requests at all.
- Audit log: every insert, update, delete, unlock, PIN reset, posting change — who, when, which device, and the reason.
- Backups: nightly encrypted dump as a GitHub Actions artifact (see supabase/BACKUP.md), 90-day retention.

Things the owner should keep in mind: keep the Supabase project password and the GitHub account secure (they are the
master keys); create logins only for people you trust with the data they can read; disable a login the day someone leaves.
