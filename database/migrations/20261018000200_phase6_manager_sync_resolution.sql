INSERT INTO role_permissions (role_id, organization_id, permission_code)
SELECT r.id, r.organization_id, 'sync.resolve-conflict'
FROM roles r
WHERE r.code = 'manager' AND r.is_system = true
ON CONFLICT DO NOTHING;
