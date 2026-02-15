# Goodreads Sync

Automatically downloads books from your Goodreads "to-read" shelf. Runs on a schedule (default: every hour), checks for new books, searches Anna's Archive, and saves EPUB files to a folder on your NAS.

## How it works

1. Fetches each user's Goodreads "to-read" shelf via RSS
2. Compares against a local SQLite database, queuing any new books as "pending"
3. For each pending book, searches Anna's Archive (via FlareSolverr to bypass Cloudflare)
4. Fuzzy-matches the top search results against the expected title and author
5. Downloads the EPUB and saves it to each user's configured folder
6. Retries failed books up to 5 times before marking them as permanently failed

## Prerequisites

- Docker and Docker Compose (or Portainer)
- An [Anna's Archive](https://annas-archive.li) API key for the fast download API
- Your Goodreads user ID (the number in your Goodreads profile URL)

### Finding your Goodreads ID

Go to your Goodreads profile. The URL will look like:

```
https://www.goodreads.com/user/show/104614681-yourname
```

The number (`104614681`) is your Goodreads ID. Make sure your "to-read" shelf is public so the RSS feed is accessible.

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/timoheddes/goodreads-sync-v2
cd goodreads-sync-v2
```

### 2. Create the `.env` file

```bash
cp .env.example .env
```

Edit `.env` and add your Anna's Archive API key:

```
AA_API_KEY=your_actual_api_key
```

### 3. Configure the volume mount

Edit `docker-compose.yml` and change the books volume to match your NAS path:

```yaml
volumes:
  - ./data:/app/data
  - /volume1/books:/downloads # Change /volume1/books to your NAS path
```

The left side is the path on your NAS, the right side (`/downloads`) is where it appears inside the container. When adding users later, their download paths should start with `/downloads/`.

### 4. Deploy

**With Docker Compose:**

```bash
docker compose up -d --build
```

**With Portainer:**

1. Go to Stacks → Add stack
2. Choose "Repository" and point it to your GitHub repo
3. Add `AA_API_KEY` as an environment variable in the Portainer UI
4. Deploy the stack

### 5. Add users

The service must be running before adding users (it creates the database tables on first start).

**Via the helper script:**

```bash
./add-user.sh "Alice" "104614681" "/downloads/Alice"
```

**Via docker exec directly:**

```bash
docker exec -it book-sync node src/add-user.js "Alice" "104614681" "/downloads/Alice"
```

**Via Portainer console:**

Open a console on the `book-sync` container and run:

```bash
node src/add-user.js "Alice" "104614681" "/downloads/Alice"
```

Arguments:

- `"Alice"` — Display name (for logs)
- `"104614681"` — Goodreads user ID
- `"/downloads/Alice"` — Download path **inside the container** (maps to your NAS volume)

You can add multiple users. Each user gets their own download folder and their books are synced independently.

## Configuration

All configuration is via environment variables in `docker-compose.yml`:

| Variable        | Default                       | Description                                          |
| --------------- | ----------------------------- | ---------------------------------------------------- |
| `AA_API_KEY`    | _(required)_                  | Anna's Archive API key (set in `.env`)               |
| `CRON_SCHEDULE` | `0 * * * *`                   | How often to sync (cron syntax, default: every hour) |
| `FLARE_URL`     | `http://flaresolverr:8191/v1` | FlareSolverr endpoint                                |
| `TZ`            | `Europe/Amsterdam`            | Timezone for logs and cron                           |
| `DB_PATH`       | `/app/data/books.db`          | SQLite database path                                 |

## Manual trigger

To kick off a sync cycle without waiting for the cron schedule:

```bash
docker kill --signal=SIGUSR1 book-sync
```

This signals the running process to start a cycle immediately. If a cycle is already in progress, the signal is ignored. Check the logs to see it run (`trigger: manual`).

## Logs

The service logs everything to stdout, viewable via:

```bash
docker logs -f book-sync
```

Or through Portainer's container logs view.

Log output includes timestamps, prefixed sections (`[RSS]`, `[Queue]`, `[Search]`, `[Download]`, `[Match]`), and cycle timing. On startup it prints the full configuration for verification.

## Updating

Pull the latest code and rebuild:

```bash
git pull
docker compose up -d --build
```

Or in Portainer: pull and redeploy the stack.

## Data

- **Database**: Stored in `./data/books.db` (persisted via volume mount)
- **Downloads**: Saved to each user's configured path under the `/downloads` mount
- **Temp files**: Stored briefly in `./data/tmp/` during download, cleaned up automatically

The database tracks book status (`pending`, `downloaded`, `failed`), attempt counts, and which users are linked to which books.
