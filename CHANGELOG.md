# Changelog

## [0.4.0](https://github.com/Vibiz-ai/principia/compare/v0.3.0...v0.4.0) (2026-10-29)


### Features

* **board:** agents work on several tasks at once; a busy checkout gets its own worktree ([acff207](https://github.com/Vibiz-ai/principia/commit/acff207410c07968079a48d7083939b31fcbbff9))
* **chat:** a task that stops for you asks in its conversation, as the agent who filed it ([fd36b27](https://github.com/Vibiz-ai/principia/commit/fd36b27d2489a95a1bd101315cf4203d42eb952e))
* **chat:** dock working tasks above the composer ([d99ebb1](https://github.com/Vibiz-ai/principia/commit/d99ebb166d8ac8a79978fb24656fdd946da38543))
* **chat:** dock working tasks above the composer ([8f14ea8](https://github.com/Vibiz-ai/principia/commit/8f14ea86807096c51b0e7da35dbb7b767abe5618))
* **chats:** real conversation titles and specialists created on demand ([3e49b15](https://github.com/Vibiz-ai/principia/commit/3e49b15043367926ddb9266aad87ad89cf1dba6a))
* **chat:** task cards show the run working, its live log in place, and why a queued task waits ([bf27f08](https://github.com/Vibiz-ai/principia/commit/bf27f08e7e01cf0709bdbba23f5786b948624a86))
* **chat:** tasks are the conversation's subagents, and a task is a chat ([1ad79e9](https://github.com/Vibiz-ai/principia/commit/1ad79e943286593df81a7d1ba4a436fdb5b3709b))
* **chat:** tasks are the conversation's subagents, and a task is a chat (stacks on [#72](https://github.com/Vibiz-ai/principia/issues/72)) ([233d7d3](https://github.com/Vibiz-ai/principia/commit/233d7d3221ec6deb8d163eb4117299e5248c10d5))
* **claude:** sign in to Claude Code from Principia, no Terminal ([893c1bc](https://github.com/Vibiz-ai/principia/commit/893c1bc2371a46836de0bba347ec7bc194373ab9))
* drop images into any text box; switching company reopens its last screen ([c150645](https://github.com/Vibiz-ai/principia/commit/c150645eb257535ec34b9ffe4ffcfaee6ab97684))
* **live:** clicking a live item opens the task's run streaming in Chats, labelled by what runs ([ef20249](https://github.com/Vibiz-ai/principia/commit/ef202491513f697ce933b970370b4ff29366c761))
* **phone:** add photos to a chat from the iPhone ([f855c28](https://github.com/Vibiz-ai/principia/commit/f855c282c4491280c056e1f6d96b55fd7219756e))
* **phone:** start a new chat from the phone ([aa7cb61](https://github.com/Vibiz-ai/principia/commit/aa7cb61482080f92d6b44a818b45cb9c381dba01))
* **sidebar:** Team unfolds into departments and their dashboards ([021063a](https://github.com/Vibiz-ai/principia/commit/021063a8cd2c52cba6ee9ac7ac9d566692bb385a))


### Bug Fixes

* ask to move Principia to Applications; Connect warns from the DMG ([bf8a891](https://github.com/Vibiz-ai/principia/commit/bf8a891e9d15b716529de6d8e3724b2de18492ec))
* **board:** a card dropped on Done is done ([9586cc6](https://github.com/Vibiz-ai/principia/commit/9586cc6288ed0b7337e40a851d50e81acfc09a3d))
* **browser:** closing the panel beside a browsing chat sticks ([8bd3cc2](https://github.com/Vibiz-ai/principia/commit/8bd3cc29715701bd1015f85b849edbef28c2f9f3))
* **browser:** each chat and task gets its own tabs; the panel opens only beside the chat that browses ([4f08687](https://github.com/Vibiz-ai/principia/commit/4f08687d1eb5525060199e1e231768830beb9e30))
* **browser:** let the browser panel be dragged much wider ([a221f38](https://github.com/Vibiz-ai/principia/commit/a221f386a0353dfb5e73a01d2916c2ec2214a779))
* **chat:** escape the task identifier fully in notStarted's patterns (CodeQL) ([b1b2c78](https://github.com/Vibiz-ai/principia/commit/b1b2c78ffa0c6879606068362ba560629ebe5876))
* **chats:** drop images into New conversation; Home's answered row opens the chat ([c98103d](https://github.com/Vibiz-ai/principia/commit/c98103d7a2ac496fe2b6fa8b95ee5e9d449714b3))
* **chats:** Send waits for images still being saved (Codex on [#79](https://github.com/Vibiz-ai/principia/issues/79)) ([a04da16](https://github.com/Vibiz-ai/principia/commit/a04da16009c104ae66a281d6728c0418282295bf))
* **chat:** the founder's answer or "go ahead" starts the task; only answers are routed to its question ([a727fe2](https://github.com/Vibiz-ai/principia/commit/a727fe210e7bd12ab084a712960f2c2d05f369b7))
* **chat:** the founder's answer or "go ahead" starts the task; only answers are routed to its question ([d3f3538](https://github.com/Vibiz-ai/principia/commit/d3f353833baeb93db1f20cf6f7850caeddcbbe13))
* **claude:** don't read a signed-in Mac as "nobody signed in" ([1172117](https://github.com/Vibiz-ai/principia/commit/11721173dfa0d432ef6bd250253832e50a705ad6))
* never ask to move in a separate instance or the smoke test ([cfbbc81](https://github.com/Vibiz-ai/principia/commit/cfbbc817edfdd35d5d9e9adc73ad017f3f899a8b))
* **onboarding:** GitHub picker lists organisation repos too ([158db5c](https://github.com/Vibiz-ai/principia/commit/158db5cd1bc0cf19b46a90edf9f8b7850560c7d8))
* **phone:** an agent's first chat message keeps the desk history above it ([4379d4c](https://github.com/Vibiz-ai/principia/commit/4379d4ca35a596ffed1763c7f832a91c25fed1b8))
* **quit:** a failed or early quit can no longer leave the app unquittable ([4b3dc3c](https://github.com/Vibiz-ai/principia/commit/4b3dc3c9273fddcdb0266233666082f73fc5513b))
* **quit:** a failed or early quit can no longer leave the app unquittable ([62c0321](https://github.com/Vibiz-ai/principia/commit/62c03211532ab4b99ce57d93370fc966a29adc5b))
* **quit:** clear the startup watchdog once boot settles, so Cancel on the deferred quit stands ([3855e2e](https://github.com/Vibiz-ai/principia/commit/3855e2e7d0853d0265f77b220ae0709c1eaa34be))
* **reaper:** never list Principia's own launcher or helpers as leftovers ([7745975](https://github.com/Vibiz-ai/principia/commit/77459759996415cfd28b7487f155ed883aa83a1c))

## [0.3.0](https://github.com/Vibiz-ai/principia/compare/v0.2.0...v0.3.0) (2026-10-27)


### Features

* **chat:** live task card in conversations; results come back to the chat ([17ec6ed](https://github.com/Vibiz-ai/principia/commit/17ec6ed0cc4e94fe656c2e436819ff69ee3c5db1))
* **chat:** live task card in conversations; results come back to the chat ([4199d12](https://github.com/Vibiz-ai/principia/commit/4199d12b0e86b28978b7db8a64461119f33fa876))
* **chat:** task cards for tasks a chat files with company_file_task / task_create ([dd818db](https://github.com/Vibiz-ai/principia/commit/dd818db143cb8ffd2741783d9419323bdddfadd5))


### Bug Fixes

* **mac:** temple app icon and a drag-to-Applications dmg window ([43df75b](https://github.com/Vibiz-ai/principia/commit/43df75b3962ac7d31d07598120e0ce091bbd8a2f))
* **mac:** temple app icon and a drag-to-Applications dmg window ([1a3e12c](https://github.com/Vibiz-ai/principia/commit/1a3e12c2b050bb12edf960fc31b5a29674590a1a))

## [0.2.0](https://github.com/Vibiz-ai/principia/compare/v0.1.0...v0.2.0) (2026-10-27)


### Features

* **chats:** New conversation + Recent; Principia routes, one destination ([9555c59](https://github.com/Vibiz-ai/principia/commit/9555c595c27516390caad5d5f73907189cd4a9da))
* **chats:** New conversation + Recent; Principia routes, one destination ([1bb479c](https://github.com/Vibiz-ai/principia/commit/1bb479c3e2418b1f3b29e6966a916103216e516e))
* **connections:** one connection per service, shown everywhere it is used ([cc1f98c](https://github.com/Vibiz-ai/principia/commit/cc1f98c94d897e5e51c119e31eb545d45cf5964a))
* **help:** principia_help, a built-in "how to use Principia" for agents ([c09358a](https://github.com/Vibiz-ai/principia/commit/c09358ab29d2c3b2e9d4e5dd4457f069d5b0d43d))
* **help:** principia_help, a built-in "how to use Principia" for agents ([e8aefd3](https://github.com/Vibiz-ai/principia/commit/e8aefd30804b979395f1cfd87a521d09d86e6769))
* **ios:** ready for TestFlight: demo mode, privacy manifest, upload pipeline, privacy page ([963677b](https://github.com/Vibiz-ai/principia/commit/963677b0a8acb32a1389c649562b2a9991622127))
* **landing:** drop the app screenshots while the UI moves fast; the share card is the forum engraving ([27d1419](https://github.com/Vibiz-ai/principia/commit/27d14192a2abc5293b926163244262d42e14efe5))
* **landing:** lead with the product, the small stuff moves to a changelog ([ef0d190](https://github.com/Vibiz-ai/principia/commit/ef0d19084b222095c945d77127839f6c794b1ea7))
* **landing:** lead with the product; small updates move to a changelog ([7032e08](https://github.com/Vibiz-ai/principia/commit/7032e08a23f02dd8759f118a039a88ea4c4fa2b5))
* **landing:** the changelog is its own page (/changelog/), linked from the footer ([38e7f4b](https://github.com/Vibiz-ai/principia/commit/38e7f4b8b3decfc52542f8978215256d8034d16b))
* launch useprincipia.com with the unsigned Mac preview download ([8d261b9](https://github.com/Vibiz-ai/principia/commit/8d261b94cd57a2e1f9c7d027f745e7ec2d7d9fc2))
* **sounds:** short, synthesized sounds for the moments that matter ([f28c4c6](https://github.com/Vibiz-ai/principia/commit/f28c4c60b0bb1c53fa8ecbd5604529fbc1c3694d))
* **usage:** Token activity on Spend, every token on this Mac ([99bc357](https://github.com/Vibiz-ai/principia/commit/99bc35744e558ec59a94127357fbba14ddf366ab))


### Bug Fixes

* **connections:** "Connect a service once" (was "Connect one once") ([13bdb03](https://github.com/Vibiz-ai/principia/commit/13bdb034c1076f7fc6ca10dad49c9c34454f3b69))
* **onboarding:** the New business ✕ closes again ([dcb4714](https://github.com/Vibiz-ai/principia/commit/dcb4714a682ff49dcb9864c356f30e1f59c46dfc))
* **onboarding:** the New business ✕ closes again (the body sat over it at the same z-index) ([670b2d6](https://github.com/Vibiz-ai/principia/commit/670b2d689dd14c55f8cfbd2b40d0a565fe574c66))
* **onboarding:** the New business ✕ closes again (the body sat over it at the same z-index) ([3cc4aea](https://github.com/Vibiz-ai/principia/commit/3cc4aea01258d709a3c4eee3ab19ac1e5432de21))
* **phone:** chats open at the newest message and stay live on the iPhone and web apps ([436121a](https://github.com/Vibiz-ai/principia/commit/436121a66e5a27fb042fb2336df6c83a11822261))
* the Scorecard badge and every gh -R / --repo line name Vibiz-ai/principia; scrub a private folder name from three comments ([e6af65e](https://github.com/Vibiz-ai/principia/commit/e6af65eb91093f262ba0063603486f4179d92e16))
* **website:** draw the GitHub mark inline (lucide-react 1.x dropped brand icons) ([350f4bb](https://github.com/Vibiz-ai/principia/commit/350f4bb031db12cd361eaaac5cd1f92eaa522537))
