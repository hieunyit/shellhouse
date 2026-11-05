-- Public CA material is scoped to this account. Existing accounts keep OS/default trust.
ALTER TABLE s3_accounts ADD COLUMN ca_pem TEXT NOT NULL DEFAULT '';
