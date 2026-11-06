---
"@thomasfosterau/pulpit": patch
---

Declare the `effect` peer as `^4.0.0` (was `>=4.0.0-rc.118`), per the peer-range policy: every stable Effect 4 release from 4.0.0 is supported (the 4.0 release candidates and future majors fall outside the caret), and the range is raised only when a dependency requires it. The type gate and the unit suites pass with `effect` 4.0.0.
