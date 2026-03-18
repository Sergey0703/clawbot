#!/bin/bash
cd /opt/nanoclaw

# Clear stale sessions on startup — claude session files may be gone after model switch
sqlite3 store/messages.db 'DELETE FROM sessions;' 2>/dev/null || true

exec node dist/index.js
