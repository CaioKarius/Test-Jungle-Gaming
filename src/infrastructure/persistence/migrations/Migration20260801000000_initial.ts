import { Migration } from '@mikro-orm/migrations';

/**
 * Initial schema. Every invariant that must hold regardless of application bugs lives here:
 *  - uniqueness: wallet per (player, currency); idempotency key; (provider, external id);
 *    one ledger entry per (wallet, transaction); one wallet_version per wallet; inbox (consumer, message);
 *    a single processed reversal per reference;
 *  - non-negativity: wallets.balance >= 0, ledger balances >= 0;
 *  - immutability: ledger is append-only (UPDATE/DELETE/TRUNCATE raise); terminal transactions never change;
 *  - agreement: a deferred trigger checks, at COMMIT, that every wallet's balance equals the
 *    balance_after of its ledger entry for the current version.
 *
 * NOTE: no `?` characters in DDL (MikroORM runs addSql through knex.raw).
 */
export class Migration20260801000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id uuid PRIMARY KEY,
        player_id text NOT NULL CHECK (length(player_id) BETWEEN 1 AND 128),
        currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance numeric(19,2) NOT NULL CONSTRAINT wallets_balance_non_negative_ck CHECK (balance >= 0),
        version integer NOT NULL CHECK (version >= 1),
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        CONSTRAINT wallets_player_currency_uq UNIQUE (player_id, currency)
      )`);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id uuid PRIMARY KEY,
        provider_id text NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 128),
        external_transaction_id text NOT NULL CHECK (length(external_transaction_id) BETWEEN 1 AND 128),
        idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
        payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        wallet_id uuid NOT NULL REFERENCES wallets (id),
        player_id text NOT NULL,
        round_id text NOT NULL,
        game_id text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount numeric(19,2) NOT NULL CHECK (amount > 0),
        currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id text,
        reference_transaction_id uuid REFERENCES wager_transactions (id),
        status text NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code text,
        observed_balance numeric(19,2) CHECK (observed_balance IS NULL OR observed_balance >= 0),
        reference_attempts integer NOT NULL DEFAULT 0 CHECK (reference_attempts >= 0),
        next_retry_at timestamptz,
        created_at timestamptz NOT NULL,
        processed_at timestamptz,
        updated_at timestamptz NOT NULL,
        CONSTRAINT wager_tx_idempotency_key_uq UNIQUE (idempotency_key),
        CONSTRAINT wager_tx_provider_external_uq UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_tx_reversal_needs_reference_ck
          CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wager_tx_bet_has_no_reference_ck
          CHECK (kind NOT IN ('BET','OPENING') OR reference_external_transaction_id IS NULL),
        CONSTRAINT wager_tx_processed_at_ck CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL)),
        CONSTRAINT wager_tx_failure_code_ck CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT wager_tx_pending_retry_ck CHECK (status <> 'PENDING_REFERENCE' OR next_retry_at IS NOT NULL),
        CONSTRAINT wager_tx_observed_balance_ck CHECK (status = 'PENDING' OR observed_balance IS NOT NULL)
      )`);
    // A reference can be reverted by at most ONE processed REFUND/ROLLBACK (whichever kind).
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_single_reversal_uq ON wager_transactions (reference_transaction_id)
      WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK') AND reference_transaction_id IS NOT NULL`);
    this.addSql(`CREATE INDEX wager_tx_pending_due_idx ON wager_transactions (next_retry_at) WHERE status = 'PENDING_REFERENCE'`);
    this.addSql(`
      CREATE INDEX wager_tx_pending_ref_idx ON wager_transactions (provider_id, reference_external_transaction_id)
      WHERE status = 'PENDING_REFERENCE'`);
    this.addSql(`CREATE INDEX wager_tx_wallet_idx ON wager_transactions (wallet_id, created_at)`);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        seq bigint GENERATED ALWAYS AS IDENTITY,
        id uuid PRIMARY KEY,
        wallet_id uuid NOT NULL REFERENCES wallets (id),
        transaction_id uuid NOT NULL REFERENCES wager_transactions (id),
        direction text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount numeric(19,2) NOT NULL CHECK (amount > 0),
        balance_before numeric(19,2) NOT NULL CHECK (balance_before >= 0),
        balance_after numeric(19,2) NOT NULL CHECK (balance_after >= 0),
        wallet_version integer NOT NULL CHECK (wallet_version >= 1),
        created_at timestamptz NOT NULL,
        CONSTRAINT ledger_balanced_ck CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT' AND balance_after = balance_before - amount)),
        CONSTRAINT ledger_seq_uq UNIQUE (seq),
        CONSTRAINT ledger_one_entry_per_wallet_tx_uq UNIQUE (wallet_id, transaction_id),
        CONSTRAINT ledger_wallet_version_uq UNIQUE (wallet_id, wallet_version)
      )`);
    this.addSql(`CREATE INDEX ledger_wallet_seq_idx ON wallet_ledger_entries (wallet_id, seq DESC)`);

    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name text NOT NULL,
        message_id text NOT NULL,
        payload_hash text NOT NULL,
        received_at timestamptz NOT NULL,
        processed_at timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      )`);

    this.addSql(`
      CREATE TABLE outbox_messages (
        seq bigint GENERATED ALWAYS AS IDENTITY,
        id uuid PRIMARY KEY,
        aggregate_id text NOT NULL,
        partition_key text NOT NULL,
        event_type text NOT NULL,
        payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL,
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at timestamptz NOT NULL,
        published_at timestamptz,
        CONSTRAINT outbox_seq_uq UNIQUE (seq)
      )`);
    this.addSql(`CREATE INDEX outbox_pending_seq_idx ON outbox_messages (seq) WHERE published_at IS NULL`);
    this.addSql(`CREATE INDEX outbox_pending_partition_idx ON outbox_messages (partition_key, seq) WHERE published_at IS NULL`);

    // ---- ledger: append-only --------------------------------------------------------------
    this.addSql(`
      CREATE FUNCTION ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only: % is not allowed', TG_OP;
      END;
      $$`);
    this.addSql(`
      CREATE TRIGGER ledger_no_update_delete BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION ledger_append_only()`);
    this.addSql(`
      CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries
      FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only()`);

    // ---- wager transactions: terminal states are final, identity columns immutable ---------
    this.addSql(`
      CREATE FUNCTION wager_transactions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager_transactions rows cannot be deleted';
        END IF;
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'wager transaction % is % (terminal) and cannot change', OLD.id, OLD.status;
        END IF;
        IF NEW.id IS DISTINCT FROM OLD.id
           OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
           OR NEW.external_transaction_id IS DISTINCT FROM OLD.external_transaction_id
           OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
           OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
           OR NEW.wallet_id IS DISTINCT FROM OLD.wallet_id
           OR NEW.player_id IS DISTINCT FROM OLD.player_id
           OR NEW.round_id IS DISTINCT FROM OLD.round_id
           OR NEW.game_id IS DISTINCT FROM OLD.game_id
           OR NEW.kind IS DISTINCT FROM OLD.kind
           OR NEW.amount IS DISTINCT FROM OLD.amount
           OR NEW.currency IS DISTINCT FROM OLD.currency
           OR NEW.reference_external_transaction_id IS DISTINCT FROM OLD.reference_external_transaction_id
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'immutable columns of wager transaction % cannot change', OLD.id;
        END IF;
        RETURN NEW;
      END;
      $$`);
    this.addSql(`
      CREATE TRIGGER wager_transactions_guard_trg BEFORE UPDATE OR DELETE ON wager_transactions
      FOR EACH ROW EXECUTE FUNCTION wager_transactions_guard()`);

    // ---- wallets: version moves exactly with the balance -----------------------------------
    this.addSql(`
      CREATE FUNCTION wallets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wallets cannot be deleted';
        END IF;
        IF NEW.id <> OLD.id OR NEW.player_id <> OLD.player_id OR NEW.currency <> OLD.currency
           OR NEW.created_at <> OLD.created_at THEN
          RAISE EXCEPTION 'immutable columns of wallet % cannot change', OLD.id;
        END IF;
        IF NEW.balance <> OLD.balance THEN
          IF NEW.version <> OLD.version + 1 THEN
            RAISE EXCEPTION 'wallet % balance changed without exactly one version increment', OLD.id;
          END IF;
        ELSIF NEW.version <> OLD.version THEN
          RAISE EXCEPTION 'wallet % version changed without a balance change', OLD.id;
        END IF;
        RETURN NEW;
      END;
      $$`);
    this.addSql(`
      CREATE TRIGGER wallets_guard_trg BEFORE UPDATE OR DELETE ON wallets
      FOR EACH ROW EXECUTE FUNCTION wallets_guard()`);

    // ---- wallets <-> ledger agreement, verified at COMMIT ----------------------------------
    this.addSql(`
      CREATE FUNCTION wallets_assert_ledger_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        entry_balance numeric(19,2);
      BEGIN
        SELECT balance_after INTO entry_balance
          FROM wallet_ledger_entries
         WHERE wallet_id = NEW.id AND wallet_version = NEW.version;
        IF NOT FOUND THEN
          IF NEW.version = 1 AND NEW.balance = 0 THEN
            RETURN NULL; -- wallet opened with a zero balance: nothing to account for yet
          END IF;
          RAISE EXCEPTION 'wallet % (version %, balance %) has no matching ledger entry', NEW.id, NEW.version, NEW.balance;
        END IF;
        IF entry_balance <> NEW.balance THEN
          RAISE EXCEPTION 'wallet % balance % differs from ledger balance_after % at version %', NEW.id, NEW.balance, entry_balance, NEW.version;
        END IF;
        RETURN NULL;
      END;
      $$`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallets_ledger_consistency_trg AFTER INSERT OR UPDATE ON wallets
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wallets_assert_ledger_consistency()`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TRIGGER IF EXISTS wallets_ledger_consistency_trg ON wallets`);
    this.addSql(`DROP TRIGGER IF EXISTS wallets_guard_trg ON wallets`);
    this.addSql(`DROP TRIGGER IF EXISTS wager_transactions_guard_trg ON wager_transactions`);
    this.addSql(`DROP TRIGGER IF EXISTS ledger_no_truncate ON wallet_ledger_entries`);
    this.addSql(`DROP TRIGGER IF EXISTS ledger_no_update_delete ON wallet_ledger_entries`);
    this.addSql(`DROP TABLE IF EXISTS outbox_messages`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions`);
    this.addSql(`DROP TABLE IF EXISTS wallets`);
    this.addSql(`DROP FUNCTION IF EXISTS wallets_assert_ledger_consistency()`);
    this.addSql(`DROP FUNCTION IF EXISTS wallets_guard()`);
    this.addSql(`DROP FUNCTION IF EXISTS wager_transactions_guard()`);
    this.addSql(`DROP FUNCTION IF EXISTS ledger_append_only()`);
  }
}
