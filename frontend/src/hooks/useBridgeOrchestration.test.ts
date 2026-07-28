// @vitest-environment jsdom

import { renderHook, act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useBridgeOrchestration } from './useBridgeOrchestration';

const ETH = '0x1111111111111111111111111111111111111111';
const XLM = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422';
const SOL = '11111111111111111111111111111111';

describe('useBridgeOrchestration', () => {
  it('returns default direction and empty amount', () => {
    const { result } = renderHook(() =>
      useBridgeOrchestration({ ethAddress: ETH, stellarAddress: XLM, solanaAddress: SOL }),
    );
    expect(result.current.direction).toBe('eth_to_xlm');
    expect(result.current.amount).toBe('');
    expect(result.current.isSubmitting).toBe(false);
  });

  it('derives fromToken and toToken from direction', () => {
    const { result } = renderHook(() =>
      useBridgeOrchestration({ ethAddress: ETH, stellarAddress: XLM, solanaAddress: SOL }),
    );
    expect(result.current.fromToken.symbol).toBe('ETH');
    expect(result.current.toToken.symbol).toBe('XLM');
  });

  it('reports walletsReady false when Stellar is missing for eth_to_xlm', () => {
    const { result } = renderHook(() =>
      useBridgeOrchestration({ ethAddress: ETH, stellarAddress: '', solanaAddress: '' }),
    );
    expect(result.current.walletsReady).toBe(false);
  });

  it('clears persisted draft via clearPersistedDraft', () => {
    const { result } = renderHook(() =>
      useBridgeOrchestration({ ethAddress: ETH, stellarAddress: XLM, solanaAddress: SOL }),
    );
    act(() => result.current.setAmount('0.5'));
    expect(result.current.amount).toBe('0.5');
    act(() => result.current.clearPersistedDraft());
    // After clearing, localStorage should be empty
    expect(window.localStorage.getItem('wafflefinance_bridge_draft_v1')).toBeNull();
  });
});
