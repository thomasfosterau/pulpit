---
"@thomasfosterau/pulpit": minor
---

`./audience` invitations (pulpit#227): `invite`, `accept`, `decline`, `revoke`, `invitations` and `myInvitations`, as pending memberships that open no `group` row and grant no admin rights until accepted. `MembershipStore` gains the invitation methods, and its membership reads take active rows alone.
