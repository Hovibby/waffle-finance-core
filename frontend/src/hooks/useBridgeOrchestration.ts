import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BridgeDirection, BridgeToken } from './useRouteDerivedValues';
import { BRIDGE_DIRECTION_MAP, BRIDGE_ROUTE_OPTIONS } from './useRouteDerivedValues';
import { validateRouteWallets } from '../utils/validation';
import { classifyProviderError, classifyReceiptTimeout, classifyRevertedTx, type OrderSubmissionFailure, type OrderSubmissionResult } from '../lib/orderSubmissionFallback';
import { usePersistedBridgeDraft } from './usePersistedBridgeDraft';
import { useTransactionHistoryCache } from './useTransactionHistoryCache';

export interface BridgeOrchestrationState {
  direction: BridgeDirection;
  amount: string;
  setDirection: (d: BridgeDirection) => void;
  setAmount: (a: string) => void;
  isSubmitting: boolean;
  setIsSubmitting: (v: boolean) => void;
  orderCreated: boolean;
  setOrderCreated: (v: boolean) => void;
  orderId: string | null;
  setOrderId: (v: string | null) => void;
  statusMessage: string;
  setStatusMessage: (v: string) => void;
  balance: string;
  setBalance: (v: string) => void;
  activeQuote: any | null;
  setActiveQuote: (v: any | null) => void;
  fromToken: BridgeToken;
  toToken: BridgeToken;
  walletsReady: boolean;
  unsupportedReasonsByRoute: Partial<Record<BridgeDirection, string>>;
  clearPersistedDraft: () => void;
  wasRestored: boolean;
}

export interface UseBridgeOrchestrationParams {
  ethAddress: string;
  stellarAddress: string;
  solanaAddress?: string;
}

export function useBridgeOrchestration({
  ethAddress,
  stellarAddress,
  solanaAddress,
}: UseBridgeOrchestrationParams): BridgeOrchestrationState {
  const draft = usePersistedBridgeDraft({
    ethAddress,
    stellarAddress,
    solanaAddress: solanaAddress ?? '',
  });

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [orderCreated, setOrderCreated] = useState(false);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [balance, setBalance] = useState('0');
  const [activeQuote, setActiveQuote] = useState<any | null>(null);

  const { fromToken, toToken } = useMemo(
    () => BRIDGE_DIRECTION_MAP[draft.direction],
    [draft.direction],
  );

  const walletsReady = useMemo(
    () => validateRouteWallets(draft.direction, ethAddress, stellarAddress, solanaAddress ?? '').isValid,
    [draft.direction, ethAddress, stellarAddress, solanaAddress],
  );

  const unsupportedReasonsByRoute = useMemo(() => {
    const out: Partial<Record<BridgeDirection, string>> = {};
    for (const route of BRIDGE_ROUTE_OPTIONS) {
      const r = validateRouteWallets(route, ethAddress, stellarAddress, solanaAddress ?? '');
      if (!r.isValid) out[route] = r.message;
    }
    return out;
  }, [ethAddress, stellarAddress, solanaAddress]);

  const clearPersistedDraft = useCallback(() => {
    draft.clearPersistedDraft();
  }, [draft]);

  return {
    direction: draft.direction,
    amount: draft.amount,
    setDirection: draft.setDirection,
    setAmount: draft.setAmount,
    isSubmitting,
    setIsSubmitting,
    orderCreated,
    setOrderCreated,
    orderId,
    setOrderId,
    statusMessage,
    setStatusMessage,
    balance,
    setBalance,
    activeQuote,
    setActiveQuote,
    fromToken,
    toToken,
    walletsReady,
    unsupportedReasonsByRoute,
    clearPersistedDraft,
    wasRestored: draft.wasRestored,
  };
}
