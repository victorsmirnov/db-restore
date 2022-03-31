Work in progress.

### How to create AWS secret for the GitHub OAuth token

```bash
aws secretsmanager create-secret \
    --name "insert your secret name here." \
    --description "GitHub OAuth token for the db-restore scripts." \
    --secret-string "insert your GitHub OAuth token."
```
