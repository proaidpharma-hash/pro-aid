# Restoring a nightly backup

Backups are GitHub Actions artifacts (Actions → "Nightly encrypted backup" → pick a run → download).
Each file is the data of every table, gzip-compressed and AES-256 encrypted with the BACKUP_PASSPHRASE secret.

    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass pass:'<passphrase>' -in proaid-2026-09-08.sql.gz.enc | gunzip > proaid.sql
    psql "<SUPABASE_DB_URL>" -f proaid.sql     # into an empty project after running the migrations

Photos live in Supabase Storage (bucket "proofs") and are not part of this file.

## Photos

The "Monthly encrypted backup of the proof photos" workflow stores one archive per month (all photos of that month),
encrypted with the same passphrase. It needs two more secrets: SUPABASE_URL (the project URL) and
SUPABASE_SERVICE_ROLE_KEY (Supabase → Project Settings → API → service_role; keep it secret — it bypasses all rules).

    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass pass:'<passphrase>' -in proaid-photos-2026-09.tar.gz.enc | tar -xz
