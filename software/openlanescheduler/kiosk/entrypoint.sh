#!/bin/sh

# Inject environment variables into index.html
cat > /usr/share/nginx/html/config.js << EOF
window.__KIOSK_LANES__ = '${KIOSK_LANES:-[1,2]}';
// Backend URL will use smart fallback: window.location.hostname
EOF

# Start nginx
exec nginx -g 'daemon off;'
