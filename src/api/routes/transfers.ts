import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { TransferModel } from '../../models/transfer.model';

// ---------------------------------------------------------------------------
// Explorer URL prefixes
// ---------------------------------------------------------------------------

const HYPERCORE_TX_BASE = 'https://www.flowscan.xyz/tx/';
const EVM_TX_BASE = 'https://hyperevmscan.io/tx/';

// ---------------------------------------------------------------------------
// Response serialiser
// ---------------------------------------------------------------------------

type LeanTransfer = {
  hlTxHash: string;
  evmTxHash?: string | null;
  sender: string;
  receiver: string;
  evmFrom: string;
  hlToken: string;
  evmTokenAddress?: string | null;
  tokenSymbol: string;
  amount: string;
  decimals: number;
  hlTimestamp: Date;
  evmTimestamp?: Date | null;
  evmBlockNumber?: number | null;
  status: string;
  [key: string]: unknown;
};

function toTransferResponse(doc: LeanTransfer) {
  return {
    hlTxHash:        doc.hlTxHash,
    evmTxHash:       doc.evmTxHash ?? null,
    hypercoreTxUrl:  `${HYPERCORE_TX_BASE}${doc.hlTxHash}`,
    evmTxUrl:        doc.evmTxHash ? `${EVM_TX_BASE}${doc.evmTxHash}` : null,
    sender:          doc.sender,
    receiver:        doc.receiver,
    evmFrom:         doc.evmFrom,
    hlToken:         doc.hlToken,
    evmTokenAddress: doc.evmTokenAddress ?? null,
    tokenSymbol:     doc.tokenSymbol,
    amount:          doc.amount,
    decimals:        doc.decimals,
    hlTimestamp:     doc.hlTimestamp,
    evmTimestamp:    doc.evmTimestamp ?? null,
    evmBlockNumber:  doc.evmBlockNumber ?? null,
    status:          doc.status,
  };
}

// ---------------------------------------------------------------------------
// JSON schemas for OpenAPI + validation
// ---------------------------------------------------------------------------

const walletParams = {
  type: 'object',
  properties: { wallet: { type: 'string', description: 'Wallet address (sender or receiver)' } },
  required: ['wallet'],
} as const;

const hashParams = {
  type: 'object',
  properties: { hash: { type: 'string', description: 'Hyperliquid or HyperEVM transaction hash' } },
  required: ['hash'],
} as const;

const paginationQuery = {
  type: 'object',
  properties: {
    limit:  { type: 'integer', minimum: 1, maximum: 200, default: 50, description: 'Page size' },
    offset: { type: 'integer', minimum: 0, default: 0, description: 'Records to skip' },
    status: { type: 'string', enum: ['pending', 'matched', 'failed'], description: 'Filter by transfer status' },
  },
} as const;

const transferResponseSchema = {
  type: 'object',
  properties: {
    hlTxHash:        { type: 'string', description: 'Hyperliquid transaction hash' },
    evmTxHash:       { type: ['string', 'null'], description: 'HyperEVM transaction hash (null if pending)' },
    hypercoreTxUrl:  { type: 'string', description: 'Flowscan explorer URL for HL tx' },
    evmTxUrl:        { type: ['string', 'null'], description: 'HyperEVM explorer URL (null if pending)' },
    sender:          { type: 'string', description: 'Sender wallet address' },
    receiver:        { type: 'string', description: 'Receiver wallet address' },
    evmFrom:         { type: 'string', description: 'Bridge system address on EVM side' },
    hlToken:         { type: 'string', description: 'Hyperliquid token identifier (SYMBOL:tokenId)' },
    evmTokenAddress: { type: ['string', 'null'], description: 'ERC-20 contract address (null for native HYPE)' },
    tokenSymbol:     { type: 'string', description: 'Token symbol (e.g. UETH, HYPE, USDC)' },
    amount:          { type: 'string', description: 'Human-readable decimal amount' },
    decimals:        { type: 'integer', description: 'EVM token decimals' },
    hlTimestamp:     { type: 'string', format: 'date-time', description: 'Hyperliquid transaction timestamp' },
    evmTimestamp:    { type: ['string', 'null'], format: 'date-time', description: 'EVM transaction timestamp' },
    evmBlockNumber:  { type: ['integer', 'null'], description: 'EVM block number' },
    status:          { type: 'string', enum: ['pending', 'matched', 'failed'], description: 'Transfer status' },
  },
} as const;

const paginatedTransfersResponse = {
  type: 'object',
  properties: {
    total:     { type: 'integer', description: 'Total matching records' },
    offset:    { type: 'integer', description: 'Current offset' },
    limit:     { type: 'integer', description: 'Current page size' },
    transfers: { type: 'array', items: transferResponseSchema },
  },
} as const;

const errorResponse = {
  type: 'object',
  properties: {
    error: { type: 'string', description: 'Error message' },
  },
} as const;

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export async function transferRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /transfers/:wallet
   *
   * Returns all indexed bridge transfers where the wallet is either sender or receiver.
   * Supports pagination and optional status filter.
   */
  fastify.get(
    '/transfers/:wallet',
    {
      schema: {
        tags: ['Transfers'],
        summary: 'List transfers for a wallet',
        description: 'Returns paginated bridge transfers where the wallet is sender or receiver.',
        params: walletParams,
        querystring: paginationQuery,
        response: {
          200: paginatedTransfersResponse,
        },
      },
    },
    async (
      req: FastifyRequest<{
        Params: { wallet: string };
        Querystring: { limit?: number; offset?: number; status?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const wallet = req.params.wallet.toLowerCase();
      const limit  = req.query.limit  ?? 50;
      const offset = req.query.offset ?? 0;
      const status = req.query.status;

      const filter: Record<string, unknown> = {
        $or: [{ sender: wallet }, { receiver: wallet }],
      };
      if (status) filter['status'] = status;

      const [transfers, total] = await Promise.all([
        TransferModel.find(filter)
          .sort({ hlTimestamp: -1 })
          .skip(offset)
          .limit(limit)
          .lean(),
        TransferModel.countDocuments(filter),
      ]);

      return reply.send({ total, offset, limit, transfers: transfers.map(toTransferResponse) });
    },
  );

  /**
   * GET /transfers/tx/:hash
   *
   * Look up a single transfer by either its Hyperliquid tx hash or its HyperEVM tx hash.
   * Returns 404 if not found.
   */
  fastify.get(
    '/transfers/tx/:hash',
    {
      schema: {
        tags: ['Transfers'],
        summary: 'Look up a transfer by hash',
        description: 'Finds a transfer by its Hyperliquid or HyperEVM transaction hash.',
        params: hashParams,
        response: {
          200: transferResponseSchema,
          404: errorResponse,
        },
      },
    },
    async (
      req: FastifyRequest<{ Params: { hash: string } }>,
      reply: FastifyReply,
    ) => {
      const hash = req.params.hash;

      const transfer = await TransferModel.findOne({
        $or: [{ hlTxHash: hash }, { evmTxHash: hash }],
      }).lean();

      if (!transfer) {
        return reply.status(404).send({ error: 'Transfer not found' });
      }

      return reply.send(toTransferResponse(transfer));
    },
  );
}
