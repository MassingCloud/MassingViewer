---
"@massingviewer/embed": minor
---

New package: `createMassingViewer()` — the one function a host imports — plus the M9 seam ledger.

`kernel` is required rather than defaulted, because `ViewerCtx.api: ApiClient` becoming
`ViewerCtx.kernel: KernelProvider` is the whole extraction in miniature, and a facade that quietly built a
LocalKernel would let that coupling survive the migration invisibly. `seamCoverage()` answers "can massing delete
its viewer yet" as a fraction with named gaps, so it is not an opinion.
