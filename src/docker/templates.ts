import { SHARED_NETWORK_NAME } from "../paths.js";
import type { DbEngine, GatewaySettings, SiteConfig, SiteContext } from "../types.js";

export function dbImageForEngine(engine: DbEngine): string {
  return engine === "mysql" ? "mysql:8.4" : "mariadb:10.11";
}

/**
 * Engine-appropriate readiness probe. `healthcheck.sh` ships with the official
 * mariadb image; mysql uses mysqladmin ping against root.
 */
export function dbHealthcheck(engine: DbEngine): string {
  if (engine === "mysql") {
    return `    healthcheck:
      test: ["CMD-SHELL", "mysqladmin ping -h localhost -uroot -p$$MYSQL_ROOT_PASSWORD --silent"]
      interval: 5s
      timeout: 3s
      retries: 30
`;
  }
  return `    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 5s
      timeout: 3s
      retries: 30
`;
}

export function composeYaml(site: SiteConfig, ctx: SiteContext): string {
  const engine = site.dbEngine ?? "mariadb";
  const image = dbImageForEngine(engine);
  const wpVolume = `${site.localWpPath}:/var/www/html`;

  return `services:
  db:
    image: ${image}
    environment:
      MYSQL_DATABASE: \${LOCAL_DB_NAME}
      MYSQL_USER: \${LOCAL_DB_USER}
      MYSQL_PASSWORD: \${LOCAL_DB_PASSWORD}
      MYSQL_ROOT_PASSWORD: \${LOCAL_DB_ROOT_PASSWORD}
    volumes:
      - db_data:/var/lib/mysql
    command: ["--max_allowed_packet=256M"]
${dbHealthcheck(engine)}    networks:
      - site

  wordpress:
    image: wordpress:php8.2-apache
    depends_on:
      db:
        condition: service_healthy
    environment:
      WORDPRESS_DB_HOST: db:3306
      WORDPRESS_DB_NAME: \${LOCAL_DB_NAME}
      WORDPRESS_DB_USER: \${LOCAL_DB_USER}
      WORDPRESS_DB_PASSWORD: \${LOCAL_DB_PASSWORD}
    volumes:
      - ${yamlQuote(wpVolume)}
    networks:
      site:
      ${SHARED_NETWORK_NAME}:
        aliases:
          - ${ctx.wordpressAlias}

  wpcli:
    image: wordpress:cli
    depends_on:
      db:
        condition: service_healthy
    environment:
      WORDPRESS_DB_HOST: db:3306
      WORDPRESS_DB_NAME: \${LOCAL_DB_NAME}
      WORDPRESS_DB_USER: \${LOCAL_DB_USER}
      WORDPRESS_DB_PASSWORD: \${LOCAL_DB_PASSWORD}
    working_dir: /var/www/html
    volumes:
      - ${yamlQuote(wpVolume)}
    entrypoint: ["sh", "-lc"]
    networks:
      - site

volumes:
  db_data:

networks:
  site:
  ${SHARED_NETWORK_NAME}:
    external: true
    name: ${SHARED_NETWORK_NAME}
`;
}

/** Values referenced by compose variable interpolation; written chmod 600. */
export function siteEnvContent(
  secrets: { localDbName: string; localDbUser: string; localDbPass: string; localDbRootPass: string },
  dotenvQuote: (value: string) => string,
): string {
  return [
    `# Managed by wp-localify — contains local DB credentials (chmod 600).`,
    `LOCAL_DB_NAME=${dotenvQuote(secrets.localDbName)}`,
    `LOCAL_DB_USER=${dotenvQuote(secrets.localDbUser)}`,
    `LOCAL_DB_PASSWORD=${dotenvQuote(secrets.localDbPass)}`,
    `LOCAL_DB_ROOT_PASSWORD=${dotenvQuote(secrets.localDbRootPass)}`,
    "",
  ].join("\n");
}

export function siteNginxConf(site: SiteConfig, ctx: SiteContext): string {
  return `server {
  listen 80;
  server_name ${site.localDomain};
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl;
  server_name ${site.localDomain};

  ssl_certificate     /etc/nginx/site-data/${site.key}/certs/cert.pem;
  ssl_certificate_key /etc/nginx/site-data/${site.key}/certs/key.pem;

  client_max_body_size 256M;
  resolver 127.0.0.11 ipv6=off valid=10s;
  resolver_timeout 5s;

  location / {
    set $wp_upstream ${ctx.wordpressAlias};
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_pass http://$wp_upstream:80;
  }
}
`;
}

export function gatewayComposeYaml(settings: GatewaySettings, confDir: string, sitesRoot: string): string {
  const httpPort = settings.httpPort ?? 80;
  const httpsPort = settings.httpsPort ?? 443;

  return `services:
  gateway:
    image: nginx:1.27-alpine
    ports:
      - "${httpPort}:80"
      - "${httpsPort}:443"
    volumes:
      - ${yamlQuote(`${confDir}:/etc/nginx/conf.d:ro`)}
      - ${yamlQuote(`${sitesRoot}:/etc/nginx/site-data:ro`)}
    networks:
      - ${SHARED_NETWORK_NAME}

networks:
  ${SHARED_NETWORK_NAME}:
    external: true
    name: ${SHARED_NETWORK_NAME}
`;
}

function yamlQuote(input: string): string {
  return `'${String(input).replace(/'/g, "''")}'`;
}
