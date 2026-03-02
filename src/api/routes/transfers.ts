import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { TransferModel } from '../../models/transfer.model';

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

      return reply.send({ total, offset, limit, transfers });
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

      return reply.send(transfer);
    },
  );
}
