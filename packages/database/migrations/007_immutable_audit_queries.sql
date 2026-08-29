CREATE TRIGGER audit_event_immutable_update
BEFORE UPDATE ON audit_event
BEGIN SELECT RAISE(ABORT, 'audit events are immutable'); END;
CREATE TRIGGER audit_event_immutable_delete
BEFORE DELETE ON audit_event
BEGIN SELECT RAISE(ABORT, 'audit events are immutable'); END;
CREATE TRIGGER state_transition_immutable_update
BEFORE UPDATE ON state_transition
BEGIN SELECT RAISE(ABORT, 'state transitions are immutable'); END;
CREATE TRIGGER state_transition_immutable_delete
BEFORE DELETE ON state_transition
BEGIN SELECT RAISE(ABORT, 'state transitions are immutable'); END;
