# Settings and model selections

Model discovery supplies candidates through Magpie's `provider.models` hook. The provider editor owns explicit choices: selecting only `gpt-6-astra`, saving, and reopening must leave the other three QianDao models unselected. New upstream candidates must not turn an existing explicit subset into Select all. Select none must remain empty. A failed upstream list query must retain the last list and choices.

Magpie records both selected IDs (`models`) and the list they were selected from (`pickedFrom`). When all IDs in an old `pickedFrom` are selected, its provider code includes subsequently listed IDs automatically. dao records newly discovered candidates in this list without changing `models`, so the user's explicit subset retains its meaning. This applies only to dao, and no update occurs after a failed discovery. Header defaults are compared without case differences and are written only when values change.

Saving a new Base URL and concurrency of 3 from dao's embedded page must persist both values, display success, and survive reopening. A host restart while the page stays open must not invalidate its save operation. The page service stores one local token per plugin data directory, shared by successive hosts. Missing or wrong tokens still receive 403 and a message that the edit was not saved. Save uses a normal click handler rather than sandbox-blocked HTML form submission.

Acceptance uses isolated Magpie and a local upstream. It checks the editor's rendered selections after reopening, saved provider metadata, page edits across a service restart, and the subsequent request destination. README content remains English. No other provider, Codex global settings, upstream retry policy, or saved API key is changed by these fixes.
