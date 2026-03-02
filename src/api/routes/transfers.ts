import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { TransferModel } from '../../models/transfer.model';

// ---------------------------------------------------------------------------
// Explorer URL prefixes
// ---------------------------------------------------------------------------

const HYPERCORE_TX_BASE = 'https://www.flowscan.xyz/tx/';
const EVM_TX_BASE = 'https://hyperevmscan.io/tx/';

// ---------------------------------------------------------------------------
// Response serialiser
//
// Converts a raw Mongoose lean document into the public API shape:
//   - adds computed explorer URL fields
//   - strips MongoDB/Mongoose internals (_id, __v, createdAt, updatedAt)
//   - strips internal bookkeeping fields (retryCount, lastRetryAt, decimals)
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
// Query / param schemas (used by Fastify for validation + serialisation)
// ---------------------------------------------------------------------------

const walletParams = {
  type: 'object',
  properties: { wallet: { type: 'string' } },
  required: ['wallet'],
} as const;

const hashParams = {
  type: 'object',
  properties: { hash: { type: 'string' } },
  required: ['hash'],
} as const;

const paginationQuery = {
  type: 'object',
  properties: {
    limit:  { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    offset: { type: 'integer', minimum: 0, default: 0 },
    status: { type: 'string', enum: ['pending', 'matched', 'failed'] },
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
   *
   * Query params:
   *   limit   (default 50, max 200)
   *   offset  (default 0)
   *   status  "pending" | "matched" | "failed"
   */
  fastify.get(
    '/transfers/:wallet',
    { schema: { params: walletParams, querystring: paginationQuery } },
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
          .sort({ hlTimestamp: -1 }) // newest first
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
    { schema: { params: hashParams } },
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
