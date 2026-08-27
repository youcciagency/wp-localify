import { describe, expect, it } from "vitest";
import {
  composeYaml,
  dbHealthcheck,
  gatewayComposeYaml,
  siteEnvContent,
  siteNginxConf,
} from "../src/docker/templates.js";
import { buildSiteContext } from "../src/site/context.js";
import { dotenvQuote } from "../src/text.js";
import { buildSiteConfig } from "../src/registry/schema.js";

const site = buildSiteConfig({ siteName: "acme", localTld: "test" });
const ctx = buildSiteContext(site);

describe("composeYaml", () => {
  it("references env placeholders instead of literal passwords", () => {
    const yaml = composeYaml(site, ctx);
    expect(yaml).toContain("${LOCAL_DB_PASSWORD}");
    expect(yaml).toContain("${LOCAL_DB_ROOT_PASSWORD}");
    expect(yaml).not.toMatch(/MYSQL_PASSWORD: ['"]/);
  });

  it("binds the wordpress alias on the shared network", () => {
    const yaml = composeYaml(site, ctx);
    expect(yaml).toContain("wp_acme");
    expect(yaml).toContain("wp-localify-net");
  });

  it("uses engine-appropriate image and healthcheck", () => {
    const mariadb = composeYaml(site, ctx);
    expect(mariadb).toContain("image: mariadb:10.11");
    expect(mariadb).toContain("healthcheck.sh");

    const mysqlSite = { ...site, dbEngine: "mysql" as const };
    const mysql = composeYaml(mysqlSite, ctx);
    expect(mysql).toContain("image: mysql:8.4");
    expect(mysql).toContain("mysqladmin ping");
    expect(dbHealthcheck("mysql")).not.toContain("healthcheck.sh");
  });

  it("mounts the site wp path", () => {
    const yaml = composeYaml(site, ctx);
    expect(yaml).toContain(`${site.localWpPath}:/var/www/html`);
  });
});

describe("siteEnvContent", () => {
  it("quotes values safely", () => {
    const content = siteEnvContent(
      { localDbName: "db", localDbUser: "u", localDbPass: 'pa"ss\\x', localDbRootPass: "root" },
      dotenvQuote,
    );
    expect(content).toContain('LOCAL_DB_NAME="db"');
    expect(content).toContain('LOCAL_DB_PASSWORD="pa\\"ss\\\\x"');
  });
});

describe("gatewayComposeYaml", () => {
  it("maps configured host ports", () => {
    const yaml = gatewayComposeYaml({ httpPort: 8080, httpsPort: 8443 }, "/conf.d", "/sites");
    expect(yaml).toContain('"8080:80"');
    expect(yaml).toContain('"8443:443"');
  });

  it("defaults to standard ports and mounts conf read-only", () => {
    const yaml = gatewayComposeYaml({ httpPort: 80, httpsPort: 443 }, "/c", "/s");
    expect(yaml).toContain('"80:80"');
    expect(yaml).toContain("/etc/nginx/conf.d:ro");
  });
});

describe("siteNginxConf", () => {
  it("proxies to the alias over TLS with forwarded proto", () => {
    const conf = siteNginxConf(site, ctx);
    expect(conf).toContain(`server_name ${site.localDomain}`);
    expect(conf).toContain("proxy_pass http://$wp_upstream:80");
    expect(conf).toContain(`certs/cert.pem`);
    expect(conf).toContain("X-Forwarded-Proto https");
  });
});
