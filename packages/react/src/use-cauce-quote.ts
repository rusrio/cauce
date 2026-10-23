import { quotePayment, toCauceError, type CauceError, type PaymentQuote } from '@cauce/core';
import { useQuery } from '@tanstack/react-query';
import { useConnection } from 'wagmi';
import { useCauceContext } from './context';

export interface UseCauceQuoteResult {
  quote: PaymentQuote | undefined;
  isLoading: boolean;
  error: CauceError | undefined;
}

/**
 * What paying `amount` from the connected chain costs right now (Circle's fee included). The
 * payment re-quotes when it starts, so treat this as an estimate.
 */
export function useCauceQuote({ amount }: { amount: bigint | undefined }): UseCauceQuoteResult {
  const { config } = useCauceContext();
  const connection = useConnection();
  const chainId = connection.status === 'connected' ? connection.chainId : undefined;
  const enabled =
    amount !== undefined &&
    amount > 0n &&
    chainId !== undefined &&
    config.getRoute(chainId) !== undefined;

  const query = useQuery({
    // bigint is not serializable in query keys.
    queryKey: ['cauce', 'quote', config.environment, chainId, amount?.toString()],
    queryFn: ({ signal }) =>
      quotePayment(config, { amount: amount ?? 0n, sourceChainId: chainId ?? 0, signal }),
    enabled,
    staleTime: 30_000,
  });

  return {
    quote: enabled ? query.data : undefined,
    isLoading: enabled && query.isLoading,
    error: query.error ? toCauceError(query.error, 'IRIS_HTTP') : undefined,
  };
}
