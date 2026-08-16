/**
 * The Node host's configuration, where a misconfiguration has to be caught.
 *
 * Cloudflare fails loudly when a binding is missing. A Node host reads strings
 * from the environment, so the equivalent failure is a default that quietly
 * papers over an absent setting — which is why the defaults are the thing worth
 * testing, not the parsing.
 */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HostConfigError, readHostConfig } from "../src/host/config.ts";

const required = {
  DATABASE_PATH: "/var/lib/confpilot/confpilot.sqlite",
  FILES_DIRECTORY: "/var/lib/confpilot/files",
  STATIC_DIRECTORY: "/srv/confpilot/web",
  PUBLIC_ORIGIN: "https://confpilot.example.org",
  SOURCE_URL: "https://git.example.org/operator/confpilot",
};

describe("node host configuration", () => {
  it("reads the paths it is given", async () => {
    const config = await readHostConfig(required);
    expect(config.databasePath).toBe(required.DATABASE_PATH);
    expect(config.filesDirectory).toBe(required.FILES_DIRECTORY);
    expect(config.staticDirectory).toBe(required.STATIC_DIRECTORY);
  });

  it.each(Object.keys(required))("refuses to start without %s", async (name) => {
    const { [name]: _omitted, ...rest } = required;
    await expect(readHostConfig(rest)).rejects.toThrow(HostConfigError);
    // Blank is the same as absent: a variable set to "" in a compose file is a
    // setting nobody supplied, not a setting whose value is empty.
    await expect(readHostConfig({ ...required, [name]: "   " })).rejects.toThrow(HostConfigError);
  });

  describe("defaults that would be a security decision if they were wrong", () => {
    it("binds loopback, not every interface", async () => {
      // This server has no TLS. Defaulting to 0.0.0.0 would publish an
      // unencrypted app to the network of any machine that ran it without
      // reading the docs; the container image opts in explicitly instead.
      expect((await readHostConfig(required)).host).toBe("127.0.0.1");
    });

    it("leaves CLIENT_IP_SOURCE unset so nothing is trusted by default", async () => {
      // client-ip.ts reads anything unrecognised as "trust nothing". Supplying a
      // default here would hand every caller a forgeable identity, and the
      // symptom — rate limits that never trigger — is invisible until abused.
      expect((await readHostConfig(required)).variables.CLIENT_IP_SOURCE).toBeUndefined();
    });

    it("passes CLIENT_IP_SOURCE through when the operator sets it", async () => {
      const config = await readHostConfig({ ...required, CLIENT_IP_SOURCE: "forwarded" });
      expect(config.variables.CLIENT_IP_SOURCE).toBe("forwarded");
    });
  });

  describe("port", () => {
    it("defaults to the Worker's dev port", async () => {
      expect((await readHostConfig(required)).port).toBe(8787);
      expect((await readHostConfig({ ...required, PORT: "" })).port).toBe(8787);
    });

    it("accepts a valid port", async () => {
      expect((await readHostConfig({ ...required, PORT: "3000" })).port).toBe(3000);
    });

    it.each([["not a number", "http"], ["trailing junk", "8787abc"], ["hexadecimal", "0x10"],
      ["exponent notation", "1e3"], ["surrounding whitespace", " 8787 "], ["zero", "0"],
      ["above the range", "70000"], ["fractional", "80.5"], ["negative", "-1"]])(
      "refuses %s", async (_label, value) => {
        // `parseInt` would read "8787abc" as 8787 and bind a port nobody asked
        // for. Refusing beats guessing when the guess is a listening socket.
        await expect(readHostConfig({ ...required, PORT: value })).rejects.toThrow(HostConfigError);
      });
  });

  describe("public URLs", () => {
    it("normalizes the browser origin and corresponding source URL", async () => {
      const config = await readHostConfig({
        ...required,
        PUBLIC_ORIGIN: "https://confpilot.example.org:443",
        SOURCE_URL: "https://git.example.org/operator/confpilot/",
      });
      expect(config.publicOrigin).toBe("https://confpilot.example.org");
      expect(config.variables.SOURCE_URL).toBe("https://git.example.org/operator/confpilot/");
    });

    it.each([
      ["a path", "https://confpilot.example.org/app"],
      ["a query", "https://confpilot.example.org/?proxy=1"],
      ["a fragment", "https://confpilot.example.org/#app"],
      ["credentials", "https://user:secret@confpilot.example.org"],
      ["cleartext on a non-loopback host", "http://confpilot.example.org"],
      ["a non-web scheme", "file:///srv/confpilot"],
    ])("rejects PUBLIC_ORIGIN with %s", async (_label, value) => {
      await expect(readHostConfig({ ...required, PUBLIC_ORIGIN: value })).rejects.toThrow(HostConfigError);
    });

    it.each(["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"])(
      "allows cleartext only for local development at %s",
      async (value) => {
        expect((await readHostConfig({ ...required, PUBLIC_ORIGIN: value })).publicOrigin).toBe(value);
      },
    );

    it.each([
      "https://user:secret@git.example.org/operator/confpilot",
      "ssh://git.example.org/operator/confpilot",
    ])("rejects an unsafe SOURCE_URL: %s", async (value) => {
      await expect(readHostConfig({ ...required, SOURCE_URL: value })).rejects.toThrow(HostConfigError);
    });

    it("rejects a runtime source offer that differs from the built web application", async () => {
      await expect(readHostConfig({
        ...required,
        BUILD_SOURCE_URL: "https://git.example.org/operator/confpilot",
        SOURCE_URL: "https://git.example.org/operator/different",
      })).rejects.toThrow(/exactly match/);
    });
  });

  describe("refuses a layout that would publish private data", () => {
    // Everything under STATIC_DIRECTORY is served to anyone who asks. Putting the
    // database or the private file store beneath it turns every unpublished
    // proposal, every headshot, and the session table into a URL — with no error
    // and no failing request, just a working server serving the wrong things.
    it.each([
      ["the private file store inside the static root", { FILES_DIRECTORY: "/srv/confpilot/web/files" }],
      ["the database inside the static root", { DATABASE_PATH: "/srv/confpilot/web/confpilot.sqlite" }],
      ["the database deep inside the static root", { DATABASE_PATH: "/srv/confpilot/web/data/db.sqlite" }],
      ["the static root and the file store being the same directory",
        { FILES_DIRECTORY: "/srv/confpilot/web" }],
      ["the static root inside the file store",
        { STATIC_DIRECTORY: "/var/lib/confpilot/files/web" }],
      ["the database inside the file store",
        { DATABASE_PATH: "/var/lib/confpilot/files/confpilot.sqlite" }],
    ])("rejects %s", async (_label, override) => {
      await expect(readHostConfig({ ...required, ...override })).rejects.toThrow(HostConfigError);
    });

    it("says which setting to move, and where it must not be", async () => {
      // The operator has to be able to act on this without reading the source.
      await expect(readHostConfig({ ...required, FILES_DIRECTORY: "/srv/confpilot/web/files" })).rejects.toThrow(/FILES_DIRECTORY.*STATIC_DIRECTORY/s);
    });

    it("accepts a normal layout, including sibling directories", async () => {
      await expect(readHostConfig(required)).resolves.toBeDefined();
      await expect(readHostConfig({
        ...required,
        DATABASE_PATH: "/srv/confpilot/data/confpilot.sqlite",
        FILES_DIRECTORY: "/srv/confpilot/data/files",
        STATIC_DIRECTORY: "/srv/confpilot/web",
      })).resolves.toBeDefined();
    });

    it("is not fooled by an unnormalised path", async () => {
      // `/srv/confpilot/web/../web/files` is inside the static root; a plain
      // string comparison would not say so.
      await expect(readHostConfig({ ...required, FILES_DIRECTORY: "/srv/confpilot/web/../web/files" })).rejects.toThrow(HostConfigError);
    });

    describe("through symlinks", () => {
      let root;
      beforeEach(() => { root = mkdtempSync(join(tmpdir(), "confpilot-layout-")); });
      afterEach(() => rmSync(root, { force: true, recursive: true }));

      it("rejects a file store that only looks separate", async () => {
        // The lexical check passes: /root/uploads is not under /root/web. The
        // symlink puts it there, so the uploads really are public and the static
        // handler would serve them entirely correctly — which is why comparing
        // where paths resolve to is the check that matters.
        mkdirSync(join(root, "web", "private"), { recursive: true });
        symlinkSync(join(root, "web", "private"), join(root, "uploads"));
        await expect(readHostConfig({
          PUBLIC_ORIGIN: required.PUBLIC_ORIGIN,
          SOURCE_URL: required.SOURCE_URL,
          DATABASE_PATH: join(root, "db.sqlite"),
          FILES_DIRECTORY: join(root, "uploads"),
          STATIC_DIRECTORY: join(root, "web"),
        })).rejects.toThrow(HostConfigError);
      });

      it("rejects a static root that only looks separate", async () => {
        mkdirSync(join(root, "uploads", "public"), { recursive: true });
        mkdirSync(join(root, "data"), { recursive: true });
        symlinkSync(join(root, "uploads", "public"), join(root, "web"));
        await expect(readHostConfig({
          PUBLIC_ORIGIN: required.PUBLIC_ORIGIN,
          SOURCE_URL: required.SOURCE_URL,
          DATABASE_PATH: join(root, "data", "db.sqlite"),
          FILES_DIRECTORY: join(root, "uploads"),
          STATIC_DIRECTORY: join(root, "web"),
        })).rejects.toThrow(HostConfigError);
      });

      it("accepts paths that do not exist yet, which is the first boot", async () => {
        // The database file and the upload directory are both created on first
        // start, so a check that required them to exist would refuse every new
        // deployment.
        mkdirSync(join(root, "web"), { recursive: true });
        await expect(readHostConfig({
          PUBLIC_ORIGIN: required.PUBLIC_ORIGIN,
          SOURCE_URL: required.SOURCE_URL,
          DATABASE_PATH: join(root, "data", "db.sqlite"),
          FILES_DIRECTORY: join(root, "data", "files"),
          STATIC_DIRECTORY: join(root, "web"),
        })).resolves.toBeDefined();
      });
    });

    it("does not reject a directory that merely shares a name prefix", async () => {
      // `/srv/confpilot/webstore` is not inside `/srv/confpilot/web`, and a
      // startsWith check without a separator would refuse to start over it.
      await expect(readHostConfig({ ...required, FILES_DIRECTORY: "/srv/confpilot/webstore" }))
        .resolves.toBeDefined();
    });
  });

  it("forwards only the settings the application reads", async () => {
    const config = await readHostConfig({
      ...required,
      CALENDAR_UID_DOMAIN: "confpilot.example.org",
      TURNSTILE_SECRET_KEY: "secret",
      CLIENT_IP_SOURCE: " forwarded ",
      AWS_SECRET_ACCESS_KEY: "not-ours",
      PATH: "/usr/bin",
    });
    expect(config.variables.CALENDAR_UID_DOMAIN).toBe("confpilot.example.org");
    expect(config.variables.TURNSTILE_SECRET_KEY).toBe("secret");
    expect(config.variables.CLIENT_IP_SOURCE).toBe("forwarded");
    // The whole environment is not the application's environment. Forwarding it
    // wholesale would put every unrelated secret on the process's `env` object.
    expect(config.variables.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(config.variables.PATH).toBeUndefined();
  });
});
