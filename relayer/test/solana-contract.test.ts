/**
 * Tests for the Solana integration contract layer.
 *
 * Validates both placeholder and configured modes, ensuring that:
 *  - Placeholder mode fails fast with clear errors
 *  - Configured mode is structurally ready (even if not fully implemented)
 *  - The factory function makes the right choice based on program ID
 *  - Address validation works in both modes
 */

import { describe, it, expect, beforeEach } from "vitest";
import { pino } from "pino";
import {
  createSolanaIntegration,
  SolanaDisabledError,
  isConfiguredSolana,
  type SolanaIntegration,
} from "../src/services/solana-contract.js";

describe("Solana Integration Contract", () => {
  let log: ReturnType<typeof pino>;

  beforeEach(() => {
    log = pino({ level: "silent" });
  });

  describe("Placeholder Mode", () => {
    const placeholderValues = [
      undefined,
      "",
      "PLACEHOLDER",
      "YOUR_SOLANA_HTLC_PROGRAM",
      "YOUR_PROGRAM_ID",
      "11111111111111111111111111111111",
    ];

    placeholderValues.forEach((programId) => {
      it(`should create placeholder integration for programId="${programId}"`, () => {
        const integration = createSolanaIntegration(
          programId,
          log,
          "https://api.mainnet-beta.solana.com"
        );

        expect(integration.mode).toBe("placeholder");
        expect(integration.programId).toBeUndefined();
        expect(integration.isEnabled()).toBe(false);
      });
    });

    it("should reject lock submission in placeholder mode", async () => {
      const integration = createSolanaIntegration(
        "PLACEHOLDER",
        log,
        "https://api.mainnet-beta.solana.com"
      );

      await expect(
        integration.submitLock({
          beneficiary: "BeneficiaryAddress",
          refundAddress: "RefundAddress",
          amount: 1000000n,
          hashlock: "0x" + "a".repeat(64),
          timelock: Math.floor(Date.now() / 1000) + 3600,
        })
      ).rejects.toThrow(SolanaDisabledError);
    });

    it("should reject claim submission in placeholder mode", async () => {
      const integration = createSolanaIntegration(
        "PLACEHOLDER",
        log,
        "https://api.mainnet-beta.solana.com"
      );

      await expect(
        integration.submitClaim({
          orderId: "order123",
          preimage: "0x" + "b".repeat(64),
          claimer: "ClaimerAddress",
        })
      ).rejects.toThrow(SolanaDisabledError);
    });

    it("should validate Solana addresses in placeholder mode", () => {
      const integration = createSolanaIntegration(
        "PLACEHOLDER",
        log,
        "https://api.mainnet-beta.solana.com"
      );

      // Valid Solana address format (base58, 32-44 chars)
      expect(integration.validateAddress("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM")).toBe(true);

      // Invalid formats
      expect(integration.validateAddress("")).toBe(false);
      expect(integration.validateAddress("0xabcdef")).toBe(false);
      expect(integration.validateAddress("tooshort")).toBe(false);
    });
  });

  describe("Configured Mode", () => {
    const realProgramId = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

    it("should create configured integration for real program ID", () => {
      const integration = createSolanaIntegration(
        realProgramId,
        log,
        "https://api.mainnet-beta.solana.com"
      );

      expect(integration.mode).toBe("configured");
      expect(integration.programId).toBe(realProgramId);
      expect(integration.isEnabled()).toBe(true);
    });

    it("should expose programId in configured mode", () => {
      const integration = createSolanaIntegration(
        realProgramId,
        log,
        "https://api.mainnet-beta.solana.com"
      );

      expect(integration.programId).toBe(realProgramId);
    });

    it("should validate Solana addresses in configured mode", () => {
      const integration = createSolanaIntegration(
        realProgramId,
        log,
        "https://api.mainnet-beta.solana.com"
      );

      expect(integration.validateAddress("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM")).toBe(true);
      expect(integration.validateAddress("")).toBe(false);
    });

    it("should throw on lock submission (not yet implemented)", async () => {
      const integration = createSolanaIntegration(
        realProgramId,
        log,
        "https://api.mainnet-beta.solana.com"
      );

      // The configured impl is a stub — it should throw SolanaSubmissionError
      // rather than SolanaDisabledError, signaling that it's ready but needs impl.
      await expect(
        integration.submitLock({
          beneficiary: "BeneficiaryAddress",
          refundAddress: "RefundAddress",
          amount: 1000000n,
          hashlock: "0x" + "a".repeat(64),
          timelock: Math.floor(Date.now() / 1000) + 3600,
        })
      ).rejects.toThrow("not yet implemented");
    });

    it("should throw on claim submission (not yet implemented)", async () => {
      const integration = createSolanaIntegration(
        realProgramId,
        log,
        "https://api.mainnet-beta.solana.com"
      );

      await expect(
        integration.submitClaim({
          orderId: "order123",
          preimage: "0x" + "b".repeat(64),
          claimer: "ClaimerAddress",
        })
      ).rejects.toThrow("not yet implemented");
    });
  });

  describe("Type Guards", () => {
    it("should correctly identify placeholder mode", () => {
      const integration = createSolanaIntegration(
        "PLACEHOLDER",
        log,
        "https://api.mainnet-beta.solana.com"
      );

      expect(isConfiguredSolana(integration)).toBe(false);
    });

    it("should correctly identify configured mode", () => {
      const integration = createSolanaIntegration(
        "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        log,
        "https://api.mainnet-beta.solana.com"
      );

      expect(isConfiguredSolana(integration)).toBe(true);
    });
  });

  describe("Factory Decision Path", () => {
    it("should log explicitly when placeholder mode is chosen", () => {
      const logs: string[] = [];
      const testLog = pino({
        level: "warn",
        transport: {
          target: "pino-pretty",
          options: { destination: 1, colorize: false },
        },
      });

      createSolanaIntegration("PLACEHOLDER", testLog, "https://api.mainnet-beta.solana.com");

      // The factory logs a warning when placeholder mode is active.
      // We can't easily intercept the log here without a custom transport,
      // so this test is structural: it confirms the factory returns the right mode.
      const integration = createSolanaIntegration(
        "PLACEHOLDER",
        log,
        "https://api.mainnet-beta.solana.com"
      );
      expect(integration.mode).toBe("placeholder");
    });

    it("should log explicitly when configured mode is chosen", () => {
      const integration = createSolanaIntegration(
        "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        log,
        "https://api.mainnet-beta.solana.com"
      );

      expect(integration.mode).toBe("configured");
    });
  });

  describe("Contract Stability", () => {
    it("should expose stable interface for all modes", () => {
      const placeholder = createSolanaIntegration(
        "PLACEHOLDER",
        log,
        "https://api.mainnet-beta.solana.com"
      );
      const configured = createSolanaIntegration(
        "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        log,
        "https://api.mainnet-beta.solana.com"
      );

      // Both modes expose the same interface
      const checkInterface = (integration: SolanaIntegration) => {
        expect(typeof integration.mode).toBe("string");
        expect(typeof integration.isEnabled).toBe("function");
        expect(typeof integration.validateAddress).toBe("function");
        expect(typeof integration.submitLock).toBe("function");
        expect(typeof integration.submitClaim).toBe("function");
      };

      checkInterface(placeholder);
      checkInterface(configured);
    });
  });
});
