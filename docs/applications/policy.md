# Policy

Policies define access control behavior for app tokens.

By default, requests without matching policy access are denied.

## Policy Shape

| Property | Type | Required | Description |
| :- | :- | :-: | :- |
| name | string | yes | Policy name |
| version | string | yes | Policy version. A policy without one is refused with `invalid_policy_no_version` |
| merge | boolean | no | Merge behavior when multiple policies apply |
| priority | number | no | Evaluation precedence |
| selection | object | yes | Selector against token policy properties |
| env | object | no | Values a config's query can use |
| config | array | yes | Access definitions (verbs, endpoints, schema, query, projection, condition) |
| limit | date | no | Optional policy expiry |

A policy is checked when it's added, synced or updated, and refused with a 400, `invalid_policy`, listing each
problem in `details.issues`, when a config would grant nothing or fail when it's evaluated. Each config needs
`verbs`, a list of `GET`, `QUERY`, `POST`, `PUT`, `DELETE` or `%ALL%`; `schema`, a list of schema names; and a
`query` object (`{"access": "%FULL_ACCESS%"}` for every entity). A `projection` is `{"keys": [...]}`, and a
`condition` or `env` is an object. Earlier releases saved a config without a query, and it granted nothing. A
config's query or condition naming an operator Buttress doesn't know is one of those problems, an issue with code
`unknown_operator`; a selection naming one is refused with `invalid_policy_selection`. An operator given an operand it
can't take is one too, an issue with code `type`: `@in`, `@nin` and `@all` take a list, `@inProp` text, `@rex` and
`@rexi` a pattern, and `@elMatch` an object. So are a query's `@and`, `@or` or `@nor` given anything but a list of one
or more queries, and a condition's criterion that isn't an object of one or more operators. An `#env` value is read
when the policy is evaluated, so it isn't checked when it's saved. Earlier releases saved them, and a request through
such a query failed. A config already stored whose query can't be read for its schema, such as one giving `@in` a
value that isn't a list, grants nothing, and the token's other policies still apply; earlier releases failed the
request.

An update that writes into a config by its index, such as `config.0.query.status`, `config.0.verbs.1` or `config.2`, is
checked with the configs it leaves: the policy's, with the request's updates written. Earlier releases didn't check an
update below a config's field, so one could write any of the problems above, and took a config written past the end of
the list, leaving an empty (`null`) config before it, which failed every request by a token the policy applied to.

`QUERY` grants [searches](schema.md#searching). `SEARCH`, its name in earlier releases, is the same verb: a config
listing either grants requests made with either method, so existing policies don't need changing.

A policy that's added or synced is then read as the table types it, as an app's schema reads an entity, and a value
that isn't of its type is refused with a 400, `invalid_value`, naming it, with every problem in `details.issues`:
a `priority` that isn't a number, say, or a `limit` that isn't a date. Earlier releases stored such values as they
were given.

## Selection

A policy's `selection` says which tokens it applies to, by their policy properties. Each key names a policy property
and gives the criteria its value must pass, `{"<@op>": <value>}`, as a query gives a field's:

```json
{
  "role": { "@eq": "ACCOUNTANT" },
  "grade": { "@gte": 2, "@lt": 5 }
}
```

A token is selected only when **every** key holds, and it has each property the selection names: the selection above
doesn't select a token without a `grade`, and `{"role": {"@not": "ADMIN"}}` doesn't select a token without a `role`.
Values are compared as a query compares them: exactly, so `"admin"` isn't `"ADMIN"`, and only with values of their
own type, so `1` isn't `"1"`. A property holding a list passes when one of its values does. `@exists` reads whether
the token has the property.

`@and` and `@or` take a list of selections, which all, or any one, must select the token:

```json
{
  "@or": [
    { "role": { "@eq": "EDITOR" } },
    { "@and": [{ "team": { "@eq": "BLUE" } }, { "grade": { "@eq": 2 } }] }
  ]
}
```

A selection is refused with `invalid_policy_selection` when it names a property the app's policy property list
doesn't, a value it doesn't list, or an `@and` or `@or` that isn't a list of one or more selections. A token's
policy properties must be values the list holds as they're written. Earlier releases selected a token when any one
key held, skipped keys the token didn't have, and ignored the case of text, both here and in the list; a policy
relying on that selects fewer tokens now.

## Conditions

A config's `condition` must hold for the config to apply; a config without one, or with a `null` one, applies (earlier
releases refused a config that left the `condition` key out, except in realtime). Each key is resolved through the
env, as a query's `#env.` values are, and so is each criterion's value; a key or value that resolves to nothing fails,
and so does a criterion with no operator, `{}`, which earlier releases let hold whatever the env.
A condition reads **value OP key**, the other way round to a query:

```json
{ "#env.date.now": { "@ltDate": "2025-01-01" } }
```

holds when 2025-01-01 is before now. `@and` and `@or` take a list of conditions, which all, or any one, must hold.
Values are compared as a selection compares them. An operator, `@and` and `@or` can also be written as a query writes
them (`$eq`, `$or`). A policy naming an operator Buttress doesn't know is refused when it's saved; one stored before
that grants nothing through that config's condition or query, and the token's other policies still apply (earlier
releases failed the request). The date operators (`@gtDate`, `@gteDate`, `@ltDate`, `@lteDate`)
read both sides as dates, written as `2025-01-31`, `31/01/2025` or a time of day such as `09:00`.

## Queries

A config's `query` says which entities it reads, as a [search's query](schema.md#searching) does, with its `#env.`
values read from the env; `{"access": "%FULL_ACCESS%"}` reads every entity. Every operator a property is given
applies, so `{"age": {"@gte": 18, "@lt": 65}}` reads ages from 18 up to 65. Earlier releases applied only the first
operator a property was given, so that policy read every age from 18 up.

Each `#env.` value in a list is read too, so `{"owner": {"@in": ["#env.user.id", "#env.user.altId"]}}` reads the
entities either value names, and a list given as a value to equal, such as `{"tags": ["#env.team", "urgent"]}`, stays
a list. A list naming an `#env.` value that isn't set grants nothing through its config, as a single value that isn't
set does, rather than leaving that item out, which would let a `@nin` read more. Earlier releases compared a list's
`#env.` values as their text, so such a policy read less than it named, and read a list given as a value as an object
of its items, which matched nothing.

A config with a `projection` reads only those properties, and a read may query or sort by only them through it: the
order of a search sorted by a property would show it. A search sorting by a property no config of the token's reads is
refused with a 403, `property_access_denied`; earlier releases sorted by it.

A token whose policies give it several configs for a schema reads what they read together: each entity once, with
every property of each config whose query reads it, and a list's `skip`, `limit` and `sort` hold for the whole list. A
count counts each entity once. Configs with the same query read every property either one does, and all of them if
either has no `projection`. Earlier releases read each config's query on its own, so an entity two configs read came
back once for each, each copy with that config's properties, `skip` and `limit` held for each config rather than the
list, and a count with `actualCount` added the configs' counts up; a config with no `projection` that shared a query
with one that had one was narrowed to that one's properties.

## Realtime

A token connected over a socket is sent a change to an entity once, with what its policies let it read of it, when
they'd let a REST read reach that entity: the configs that let it read the schema, with the same conditions, queries
and `limit`. Earlier releases sent a copy for each policy, and each config, that read the entity, and read some queries
differently from a REST read: text without its case, and bare values not at all.

## Limit

A policy with a `limit` grants nothing once the limit has passed. Buttress then removes the policy, and takes off the
token the policy properties its selection took it by: each key the selection needs, and those of each `@or` branch
that holds for the token, but not those of a branch that doesn't.

## Listing and Removing

`GET /api/v1/policy` lists the app's policies; `?ids=a,b` lists only those of them. Earlier releases checked the ids
and listed every policy. `DELETE /api/v1/policy` removes the app's policies; with a system token it removes every
app's.

## CLI Commands

Create from a JSON file:

```bash
bjs policy create --filePath="./policy.json"
```

List property metadata:

```bash
bjs policy list-property
```

## Example

```json
[
  {
    "name": "email-reader",
    "version": "1",
    "selection": {
      "emailReader": {
        "@eq": true
      }
    },
    "config": [
      {
        "verbs": ["GET"],
        "schema": ["email"],
        "query": {
          "access": "%FULL_ACCESS%"
        }
      }
    ]
  },
  {
    "name": "junior-account-manager",
    "version": "1",
    "selection": {
      "role": {
        "@eq": "accountant"
      }
    },
    "config": [
      {
        "verbs": ["GET", "QUERY"],
        "schema": ["finance"],
        "query": {
          "salary": {
            "$lte": 40000
          }
        }
      }
    ]
  }
]
```

## Best Practices

- Prefer least privilege and explicit selectors.
- Keep admin wildcard policies separate and tightly scoped.
- Use projection/query constraints to enforce row and field-level restrictions.