#!/bin/bash
set -e
P="psql -h /tmp -p 5433 -U postgres"
$P -q -c "drop database if exists proaid" -c "create database proaid" >/dev/null
$P -q -c "drop role if exists app_user" >/dev/null 2>&1 || true
$P -d proaid -v ON_ERROR_STOP=1 -q -f tests/00_auth_stub.sql -f migrations/0001_schema.sql -f migrations/0002_api.sql -f migrations/0004_bootstrap.sql -f migrations/0005_staff_and_sale_credit.sql -f migrations/0006_day_receipts.sql
$P -d proaid -v ON_ERROR_STOP=1 -f tests/01_rules.sql 2>&1 | grep -E "PASS|FAIL|ERROR|ALL RULE"
