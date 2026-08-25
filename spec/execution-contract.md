# IAAS Execution Contract

The implementation agent receives one Work Order at a time. It must implement only the referenced Work Item, produce required evidence, and open one implementation PR.

The agent must stop on architecture ambiguity, missing prerequisites, contradictory requirements, or any need to modify a frozen architectural rule.

The agent cannot mark a Work Item VERIFIED.
