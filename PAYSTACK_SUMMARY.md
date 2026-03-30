# Paystack Integration Summary

## Environment Variables Required

```env
PAYSTACK_SECRET_KEY=sk_live_...
PAYSTACK_PUBLIC_KEY=pk_live_...
PAYSTACK_BASE_URL=https://api.paystack.co
SYSTEM_SUBACCOUNT_CODE=ACCT_...        # Platform's own Paystack subaccount
PAYSTACK_FEE_RATE=1.5                  # % charged as gateway convenience fee
CONVENIENCE_RATE_KENYA=0               # % system fee for Kenya (currently 0)
BACKEND_URL=https://your-backend.com
FRONTEND_URL=https://your-frontend.com
USD_TO_KES_RATE=129                    # For package price conversion
```

---

## Gateway Routing

Paystack is used **only for Kenya accounts**. Malawi accounts use Paychangu.

**Decision logic** (`src/utils/gatewayRouter.ts`):
1. Check `user.accountCountry` directly
2. If not set, check `user.ministryAdminId → ministryAdmin.accountCountry`
3. If still not set (member), check `user.churchId → church.ministryAdminId → ministryAdmin.accountCountry`
4. `country === 'Malawi'` → `paychangu`, everything else → `paystack`

```ts
getPaymentGateway(userId)         // resolves via user chain
getPaymentGatewayByChurch(churchId) // resolves via church → ministryAdmin
getCurrency(gateway)              // 'paychangu' → 'MWK', 'paystack' → 'KES'
getGatewayCountry(gateway)        // 'paychangu' → 'Malawi', 'paystack' → 'Kenya'
```

---

## Fee Calculation (`src/utils/feeCalculations.ts`)

```
totalAmount = baseAmount + convenienceFee + systemFeeAmount
```

| Field | Source |
|---|---|
| `convenienceFee` | `baseAmount × PAYSTACK_FEE_RATE` |
| `systemFeeAmount` | `baseAmount × CONVENIENCE_RATE_KENYA` (currently 0 for Kenya) |
| `totalAmount` | sum of all three |

Amount sent to Paystack = `totalAmount × 100` (converted to kobo/cents).

---

## Subaccounts

### What they are
Each church in Kenya can have a Paystack subaccount. When a ticket payment is made, the money goes directly to the church's bank/M-PESA account. The platform keeps the convenience fee via `transaction_charge`.

### Endpoints

| Method | Route | Permission |
|---|---|---|
| POST | `/api/subaccounts` | `subaccounts:create` |
| PUT | `/api/subaccounts/:id` | `subaccounts:update` |
| GET | `/api/subaccounts/church/:churchId` | `subaccounts:view` |
| GET | `/api/subaccounts/banks` | authenticated |

### Creating a Subaccount — Request Body
```json
{
  "churchId": "...",
  "businessName": "St. Peter Church",
  "settlementBank": "MPESA",
  "accountNumber": "0714991414",
  "percentageCharge": 0,
  "description": "Optional"
}
```

### What happens on create
1. Validates Kenya-only access (checks `user.accountCountry` or their `ministryAdmin.accountCountry`)
2. Checks church exists and no subaccount already exists for it
3. POSTs to `POST https://api.paystack.co/subaccount` with `business_name`, `settlement_bank`, `account_number`, `percentage_charge`
4. Saves returned `subaccount_code` to DB (`Subaccount` table)

### Fetching Banks
`GET /api/subaccounts/banks` → calls `GET https://api.paystack.co/bank?country=kenya`
- Filters: `currency === 'KES'` OR `type === 'mobile_money'`, must be `active` and not deleted
- Deduplicates by bank code
- Returns `[{ name, code }]`

---

## Payment Initialization

### 1. Package Subscription (`POST /api/payments/subscribe-package`)

**Flow:**
1. Validate user is authenticated, get `ministryAdminId`
2. Look up package price in USD → convert to KES via `USD_TO_KES_RATE`
3. Calculate fees via `calculatePaymentFees(baseAmount, 'Kenya')`
4. Create `PendingTransaction` in DB (expires in 1 hour) with all fee metadata
5. Call `POST https://api.paystack.co/transaction/initialize` with:
   ```json
   {
     "email": "ministryadmin@email.com",
     "amount": 150000,
     "callback_url": "BACKEND_URL/api/payments/verify",
     "subaccount": "SYSTEM_SUBACCOUNT_CODE",
     "metadata": {
       "type": "package_subscription",
       "pendingTxId": "...",
       "ministryAdminId": "...",
       "packageId": "...",
       "billingCycle": "monthly|yearly",
       "initiatedBy": "userId",
       "baseAmount": 1000,
       "convenienceFee": 15,
       "totalAmount": 1015,
       ...
     }
   }
   ```
6. Update `PendingTransaction.reference` with Paystack's reference
7. Return `{ authorization_url, access_code, reference }` to frontend

### 2. Ticket Purchase — Registered User (`POST /api/payments/purchase-ticket`)

**Flow:**
1. Validate event exists, requires ticket, is not free, has available seats
2. `baseAmount = event.ticketPrice × quantity`
3. Determine gateway via `getPaymentGateway(userId)`
4. Calculate fees
5. Create `PendingTransaction` (expires 30 min)
6. Call `POST https://api.paystack.co/transaction/initialize` with:
   ```json
   {
     "email": "user@email.com",
     "amount": 50000,
     "currency": "KES",
     "callback_url": "BACKEND_URL/api/payments/verify",
     "subaccount": "ACCT_church_subaccount_code",
     "transaction_charge": 750,
     "bearer": "account",
     "metadata": {
       "type": "event_ticket",
       "pendingTxId": "...",
       "userId": "...",
       "eventId": "...",
       "quantity": 1,
       "subaccountCode": "...",
       "subaccountName": "..."
     }
   }
   ```
   - `subaccount` = church's subaccount code (if exists)
   - `transaction_charge` = `(convenienceFee + systemFeeAmount) × 100` — this is what the platform keeps
   - `bearer: 'account'` = platform bears Paystack's own processing fee

### 3. Guest Ticket Purchase (`POST /api/payments/guest-ticket`) — No auth required

Same as registered ticket but:
- No `userId`, uses `guestEmail` as Paystack email
- `isGuest: true` stored in metadata and `PendingTransaction`
- Free events skip payment entirely — ticket created directly, PDF emailed

---

## Payment Verification / Callback

### `GET /api/payments/verify?reference=...`

Called by Paystack redirect after user pays (callback_url). Also handles idempotency if webhook already processed it.

**Flow:**
1. Call `GET https://api.paystack.co/transaction/verify/:reference`
2. Check `data.status === 'success'`
3. Read `metadata.type` to branch:
   - `package_subscription` → create `Payment` + upsert `Subscription` + delete `PendingTransaction` + send email with PDF receipt
   - `event_ticket` → create `Transaction` + create `EventTicket(s)` + increment `event.ticketsSold` + delete `PendingTransaction` + send ticket PDF + receipt PDF
   - `donation` → create `Transaction` + create `DonationTransaction` + delete `PendingTransaction` + send receipt PDF
4. Redirect to `FRONTEND_URL/payment/callback?status=success&type=...`

**Idempotency:** Before creating any record, checks if `Payment` or `Transaction` already exists for that reference. If yes, skips processing and just redirects.

---

## Webhook (`POST /api/webhooks/paystack`)

Handles server-to-server notification from Paystack. Processes the same payment types as the verify endpoint.

### Signature Verification
```
HMAC-SHA512(rawBody, PAYSTACK_SECRET_KEY) === x-paystack-signature header
```

Raw body is captured in `app.ts` before JSON parsing:
```ts
app.use('/api/webhooks/paystack', express.raw({ type: 'application/json' }), (req, _res, next) => {
  req.rawBody = req.body as Buffer;
  req.body = JSON.parse(req.body.toString());
  next();
});
```

### Supported Events
Only `charge.success` is processed. All other events return `{ received: true }` immediately.

### Flow (same as verify but triggered server-side)
1. Verify signature
2. Re-verify transaction with Paystack API (`/transaction/verify/:reference`)
3. Branch on `metadata.type` → same logic as verify endpoint
4. Always return `200 { received: true }` (even on errors, to prevent Paystack retries)

---

## Data Stored Per Transaction

| Field | Source |
|---|---|
| `reference` | Paystack reference |
| `amount` | `txData.amount / 100` |
| `baseAmount` | from `PendingTransaction.metadata` |
| `convenienceFee` | from `PendingTransaction.metadata` |
| `systemFeeAmount` | from `PendingTransaction.metadata` |
| `totalAmount` | from `PendingTransaction.metadata` |
| `gatewayCharge` | `txData.fees / 100` (Paystack's own fee) |
| `subaccountCode` | `txData.subaccount.subaccount_code` |
| `subaccountName` | `txData.subaccount.business_name` |
| `cardLast4` | `txData.authorization.last4` |
| `cardBank` | `txData.authorization.bank` |
| `channel` | `txData.channel` (card, mobile_money, etc.) |
| `paidAt` | `txData.paid_at` |
| `gatewayResponse` | full raw Paystack response (JSON string) |

---

## Frontend (Subaccount Page)

**File:** `src/pages/Subaccount.tsx`

- Only renders for `user.accountCountry === 'Kenya'`, shows "Not Available" otherwise
- Fetches banks via `subaccountsService.getBanks()`
- Fetches existing subaccount via `subaccountsService.getByChurch(churchId)`
- Create/update form uses `react-hook-form` + `zod` validation
- Toggle active/inactive via update mutation with `{ active: boolean }`
- M-PESA hint shown when bank code is `MPESA`, `MPPAYBILL`, or `MPTILL`

**Frontend service** (`src/services/subaccounts.ts`):
```ts
subaccountsService.create(dto)           // POST /api/subaccounts
subaccountsService.update(id, dto)       // PUT /api/subaccounts/:id
subaccountsService.getByChurch(churchId) // GET /api/subaccounts/church/:churchId
subaccountsService.getBanks()            // GET /api/subaccounts/banks
```

---

## Full Payment Flow Summary

```
Frontend initiates payment
        ↓
POST /api/payments/[subscribe-package | purchase-ticket | guest-ticket]
        ↓
Create PendingTransaction (stores all fee breakdown in metadata)
        ↓
POST https://api.paystack.co/transaction/initialize
        ↓
Return { authorization_url } to frontend
        ↓
Frontend redirects user to authorization_url (Paystack hosted page)
        ↓
User pays on Paystack
        ↓
Paystack fires webhook → POST /api/webhooks/paystack  (server-to-server)
        AND
Paystack redirects user → GET /api/payments/verify?reference=... (user browser)
        ↓
Whichever arrives first processes the payment (idempotency check prevents double processing)
        ↓
DB records created + PendingTransaction deleted + email + PDF sent
        ↓
User redirected to FRONTEND_URL/payment/callback?status=success&type=...
```
