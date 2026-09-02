/**
 * WagmiRainbowProvider
 *
 * Wraps the application with the wagmi v2 and RainbowKit v2 context providers.
 * Must sit above any component that calls wagmi hooks or renders the
 * RainbowKit ConnectButton / modal.
 *
 * Provider order matters:
 *   WagmiProvider  → makes the wagmi config available to all hooks
 *   QueryClientProvider → React Query cache shared by wagmi's async hooks
 *   RainbowKitProvider  → RainbowKit modal, theming, and wallet list
 *
 * The QueryClient is created once per module load (outside the component) so
 * it survives React StrictMode's double-invoke and HMR refreshes without
 * accumulating duplicate cache instances.
 */

import type { ReactNode } from 'react';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit';
import { wagmiConfig } from '../config/wagmi';

// Import RainbowKit base styles once here so consumers don't need to.
import '@rainbow-me/rainbowkit/styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Match the project's existing SWR strategy: data is fresh for 15 s,
      // stale for up to 60 s, then revalidated in the background.
      staleTime: 15_000,
      gcTime: 60_000,
      retry: 1,
    },
  },
});

export interface WagmiRainbowProviderProps {
  children: ReactNode;
}

export default function WagmiRainbowProvider({ children }: WagmiRainbowProviderProps) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={darkTheme({
            accentColor: '#4f6bff',
            accentColorForeground: 'white',
            borderRadius: 'large',
            fontStack: 'system',
          })}
          modalSize="compact"
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
