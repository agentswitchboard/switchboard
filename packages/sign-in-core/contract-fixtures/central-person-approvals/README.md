# Central person approvals wire (C3)

Consumer copies from codex-router `8670195564d6af00d4e21d80c806b8ebc28f7a6f`, which is not on central `main` yet. Sources, as handed to sign-in in the DEL-06 packet:

| File | SHA-256 |
|---|---|
| `central-sign-in.ts` (vendored as `src/central-link/generated/central-sign-in.gen.ts`) | `e8dd8517a7c8f1af1bb1799e926672761039cfb7a15c307029cc8453ddd452ba` |
| `approval_person_wire.rs` | `4e2f47c3145171d34bf7b3008df3bf2fad3f0be7157bc475d7a12d01febd3577` |
| `signin_approval_wire_specimens_test.rs` | `ff1b832c948ffd630216a0c5693c7f632b1fa35974803bbb85ae598be089c515` |

- `specimen-literals.json` holds the reply and request bodies central's specimens test writes inline, exactly as written there: one accepted last page and the malformed bodies it refuses.
- Central's byte vectors for the three canonical intents and for each reply variant live in that commit's `contracts/approval-intent-vector.json` and `contracts/approval-person-reply-vectors.json`. They are not copied here yet; see the DEL-06 handback.

`POST /organization-admin/v1/approval-{list,read,decide}` travels the private link with `Authorization: DPoP <person-fleet token>` and `DPoP: <proof>`, like the admin routes. The proof's `intent` is base64url(SHA-256(JCS(intent))) over central's `ApprovalIntent`. All three need `approval:decide`.

These fixtures define parsing and the intent only. They earn no credit for central's admission, factor standing, replay or decision rules.
