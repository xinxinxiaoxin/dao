# Attribution

The Magpie integration setup and isolated host test harness draw on
[magpie-agentrouter-relay](https://github.com/xinxinxiaoxin/magpie-agentrouter-relay),
licensed under MIT. Its copyright notice is included in [LICENSE](LICENSE).

The retry policy follows the author's
[QianDao gateway](https://github.com/xinxinxiaoxin/qiandao), with explicit terminal
errors preserved and request budgets shared across Magpie retries.

Magpie and its plugin runtime are external dependencies. Their source is not
included in the dao package.
