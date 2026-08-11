FROM node:20-alpine AS build
WORKDIR /app

# Accept build arguments
ARG VITE_BACKEND_URL=/
ARG VITE_LANES=1,2,3,4,5,6,7,8

# Set as environment variables for Vite build
ENV VITE_BACKEND_URL=$VITE_BACKEND_URL
ENV VITE_LANES=$VITE_LANES

COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
