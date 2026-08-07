FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

COPY pyproject.toml uv.lock .
RUN uv sync --frozen --no-install-project

COPY . .

EXPOSE 8000

CMD ["uv", "run", "main.py"]
