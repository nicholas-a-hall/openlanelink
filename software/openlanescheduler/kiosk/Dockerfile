FROM node:20-alpine AS build
WORKDIR /app

# Accept build arguments
ARG VITE_KIOSK_LANES=[1,2]

# Set as environment variables for Vite build
ENV VITE_KIOSK_LANES=$VITE_KIOSK_LANES

COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine

# Pass build args to runtime
ARG VITE_KIOSK_LANES=[1,2]

# Set runtime environment variables (without VITE_ prefix for entrypoint.sh)
ENV KIOSK_LANES=$VITE_KIOSK_LANES

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 80
ENTRYPOINT ["/entrypoint.sh"]
