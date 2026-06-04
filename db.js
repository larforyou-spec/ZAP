// db.js — In-memory database simulation for development/testing
// Mimics the pg (node-postgres) interface: db.query(), db.transaction(), db.pool.connect()

const tables = {};
const sequences = {};

function getTable(name) {
    if (!tables[name]) tables[name] = [];
    return tables[name];
}

function nextId(table) {
    if (!sequences[table]) sequences[table] = 0;
    sequences[table]++;
    return sequences[table];
}

// Simple SQL parser that handles the queries used in server.js
function executeQuery(sql, params = []) {
    let text = sql.trim().replace(/\s+/g, ' ');

    // Replace $1, $2 etc with actual values
    const resolvedParams = [...params];

    // Detect query type
    const upper = text.toUpperCase();

    if (upper.startsWith('CREATE TABLE') || upper.startsWith('CREATE INDEX') ||
        upper.startsWith('ALTER TABLE') || upper.startsWith('CREATE UNIQUE')) {
        // DDL — extract table name and ensure it exists
        const match = text.match(/(?:CREATE TABLE IF NOT EXISTS|CREATE TABLE|ALTER TABLE)\s+"?(\w+)"?/i);
        if (match) getTable(match[1]);
        return { rows: [], rowCount: 0 };
    }

    if (upper.startsWith('SELECT COUNT')) {
        const tableMatch = text.match(/FROM\s+(\w+)/i);
        if (tableMatch) {
            const t = getTable(tableMatch[1]);
            return { rows: [{ count: t.length }], rowCount: 1 };
        }
        return { rows: [{ count: 0 }], rowCount: 1 };
    }

    if (upper.startsWith('SELECT MAX')) {
        const colMatch = text.match(/MAX\((\w+)\)/i);
        const tableMatch = text.match(/FROM\s+(\w+)/i);
        if (colMatch && tableMatch) {
            const col = colMatch[1];
            const t = getTable(tableMatch[1]);
            const filtered = applyWhere(t, text, resolvedParams);
            const maxVal = filtered.reduce((max, r) => {
                const v = Number(r[col] || 0);
                return v > max ? v : max;
            }, 0);
            return { rows: [{ [`max_${col}`]: maxVal || null, max_bid: maxVal || null }], rowCount: 1 };
        }
        return { rows: [{ max_bid: null }], rowCount: 1 };
    }

    if (upper.startsWith('INSERT')) {
        return handleInsert(text, resolvedParams);
    }

    if (upper.startsWith('UPDATE')) {
        return handleUpdate(text, resolvedParams);
    }

    if (upper.startsWith('DELETE')) {
        return handleDelete(text, resolvedParams);
    }

    if (upper.startsWith('SELECT')) {
        return handleSelect(text, resolvedParams);
    }

    // Unknown — no-op
    return { rows: [], rowCount: 0 };
}

function resolveParam(val, params) {
    if (typeof val === 'string' && val.match(/^\$\d+$/)) {
        const idx = parseInt(val.substring(1)) - 1;
        return params[idx];
    }
    return val;
}

function parseValue(val) {
    if (val === undefined || val === null) return null;
    if (typeof val === 'string') {
        const trimmed = val.trim();
        if (trimmed.toUpperCase() === 'NULL') return null;
        if (trimmed.toUpperCase() === 'NOW()') return new Date().toISOString();
        if (trimmed.toUpperCase() === 'TRUE') return true;
        if (trimmed.toUpperCase() === 'FALSE') return false;
        // Remove quotes
        if ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
            (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
            return trimmed.slice(1, -1);
        }
    }
    return val;
}

function applyWhere(tableData, sql, params) {
    const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+ORDER\s|\s+LIMIT\s|\s+GROUP\s|\s+FOR\s|\s+RETURNING\s|$)/i);
    if (!whereMatch) return [...tableData];

    let whereClause = whereMatch[1].trim();

    return tableData.filter(row => evaluateWhere(row, whereClause, params));
}

function evaluateWhere(row, clause, params) {
    // Handle AND conditions
    const andParts = clause.split(/\s+AND\s+/i);

    return andParts.every(part => {
        part = part.trim();

        // Handle OR within this AND part
        if (/\s+OR\s+/i.test(part)) {
            const orParts = part.split(/\s+OR\s+/i);
            return orParts.some(op => evaluateCondition(row, op.trim(), params));
        }

        return evaluateCondition(row, part, params);
    });
}

function evaluateCondition(row, condition, params) {
    condition = condition.trim();

    // Handle LOWER(col) = LOWER(val) — must be before stripping parens
    const lowerMatch = condition.match(/LOWER\((\w+(?:\.\w+)?)\)\s*=\s*LOWER\((.+?)\)/i);
    if (lowerMatch) {
        const col = lowerMatch[1].split('.').pop();
        let rhs = lowerMatch[2].trim();
        if (rhs.match(/^\$\d+$/)) rhs = params[parseInt(rhs.substring(1)) - 1];
        else rhs = parseValue(rhs);
        return String(row[col] || '').toLowerCase() === String(rhs || '').toLowerCase();
    }

    // Handle IN (with subquery or list)
    const inMatch = condition.match(/(\w+(?:\.\w+)?)\s+IN\s*\(/i);
    if (inMatch) return true; // Simplified

    // Handle NOT IN
    if (/NOT\s+IN/i.test(condition)) return true; // Simplified

    // Strip remaining non-function parens for simpler matching
    const cleaned = condition.replace(/\bLOWER\([^)]+\)/gi, '').replace(/[()]/g, '').trim();

    // Handle IS NULL
    const isNullMatch = condition.match(/(\w+(?:\.\w+)?)\s+IS\s+NULL/i);
    if (isNullMatch) {
        const col = isNullMatch[1].split('.').pop();
        return row[col] === null || row[col] === undefined;
    }

    // Handle IS NOT NULL
    const isNotNullMatch = condition.match(/(\w+(?:\.\w+)?)\s+IS\s+NOT\s+NULL/i);
    if (isNotNullMatch) {
        const col = isNotNullMatch[1].split('.').pop();
        return row[col] !== null && row[col] !== undefined;
    }

    // Handle comparisons: =, !=, <>, <, >, <=, >=
    const cmpMatch = condition.match(/(\w+(?:\.\w+)?)\s*(=|!=|<>|<=|>=|<|>)\s*(.+)/);
    if (cmpMatch) {
        const col = cmpMatch[1].split('.').pop();
        const op = cmpMatch[2];
        let rhs = cmpMatch[3].trim();

        // Resolve parameter
        if (rhs.match(/^\$\d+$/)) {
            rhs = params[parseInt(rhs.substring(1)) - 1];
        } else {
            rhs = parseValue(rhs);
        }

        const lhs = row[col];

        switch (op) {
            case '=':  return lhs == rhs;
            case '!=': case '<>': return lhs != rhs;
            case '<':  return Number(lhs) < Number(rhs);
            case '>':  return Number(lhs) > Number(rhs);
            case '<=': return Number(lhs) <= Number(rhs);
            case '>=': return Number(lhs) >= Number(rhs);
        }
    }

    return true; // Fallback: don't filter
}

function handleInsert(sql, params) {
    const tableMatch = sql.match(/INSERT\s+INTO\s+(\w+)\s*/i);
    if (!tableMatch) return { rows: [], rowCount: 0 };

    const tableName = tableMatch[1];
    const table = getTable(tableName);

    // Extract columns
    const colMatch = sql.match(/\(([^)]+)\)\s*VALUES/i);
    if (!colMatch) {
        // Multi-value insert without column list
        return { rows: [], rowCount: 0 };
    }

    const columns = colMatch[1].split(',').map(c => c.trim());

    // Extract VALUES (may be multiple rows)
    const valuesSection = sql.substring(sql.toUpperCase().indexOf('VALUES') + 6);
    const returning = /RETURNING\s+/i.test(sql);

    // Parse value groups
    const valueGroups = [];
    let depth = 0, current = '';
    for (const char of valuesSection) {
        if (char === '(') { depth++; if (depth === 1) { current = ''; continue; } }
        if (char === ')') {
            depth--;
            if (depth === 0) {
                valueGroups.push(current.trim());
                current = '';
                continue;
            }
        }
        if (depth > 0) current += char;
    }

    // Handle ON CONFLICT
    const hasOnConflict = /ON\s+CONFLICT/i.test(sql);

    const insertedRows = [];
    for (const group of valueGroups) {
        const vals = splitValues(group);
        const row = { id: nextId(tableName), created_at: new Date().toISOString(), updated_at: new Date().toISOString() };

        columns.forEach((col, i) => {
            let val = vals[i]?.trim();
            if (!val) return;

            if (val.match(/^\$\d+$/)) {
                val = params[parseInt(val.substring(1)) - 1];
            } else if (val.toUpperCase() === 'NOW()') {
                val = new Date().toISOString();
            } else if (val.match(/NOW\(\)\s*\+\s*INTERVAL/i)) {
                const dayMatch = val.match(/(\d+)\s*day/i);
                const hourMatch = val.match(/(\d+)\s*hour/i);
                const minMatch = val.match(/(\d+)\s*min/i);
                const d = new Date();
                if (dayMatch) d.setDate(d.getDate() + parseInt(dayMatch[1]));
                if (hourMatch) d.setHours(d.getHours() + parseInt(hourMatch[1]));
                if (minMatch) d.setMinutes(d.getMinutes() + parseInt(minMatch[1]));
                val = d.toISOString();
            } else if (/\|\|\s*'\s*days\s*'/i.test(val)) {
                // Handle ($7 || ' days')::INTERVAL style
                const paramRef = val.match(/\$(\d+)/);
                if (paramRef) {
                    const days = Number(params[parseInt(paramRef[1]) - 1]);
                    const d = new Date();
                    d.setDate(d.getDate() + days);
                    val = d.toISOString();
                }
            } else {
                val = parseValue(val);
            }

            row[col] = val;
        });

        if (hasOnConflict) {
            const existing = table.find(r => columns.some(c => r[c] === row[c]));
            if (existing) {
                Object.assign(existing, row, { id: existing.id });
                insertedRows.push(existing);
                continue;
            }
        }

        table.push(row);
        insertedRows.push(row);
    }

    return { rows: insertedRows, rowCount: insertedRows.length };
}

function splitValues(str) {
    const result = [];
    let depth = 0, current = '', inQuote = false, quoteChar = '';

    for (let i = 0; i < str.length; i++) {
        const c = str[i];

        if (!inQuote && (c === "'" || c === '"')) {
            inQuote = true;
            quoteChar = c;
            current += c;
        } else if (inQuote && c === quoteChar) {
            inQuote = false;
            current += c;
        } else if (!inQuote && c === '(') {
            depth++;
            current += c;
        } else if (!inQuote && c === ')') {
            depth--;
            current += c;
        } else if (!inQuote && depth === 0 && c === ',') {
            result.push(current.trim());
            current = '';
        } else {
            current += c;
        }
    }
    if (current.trim()) result.push(current.trim());
    return result;
}

function handleUpdate(sql, params) {
    const tableMatch = sql.match(/UPDATE\s+(\w+)\s+SET/i);
    if (!tableMatch) return { rows: [], rowCount: 0 };

    const tableName = tableMatch[1];
    const table = getTable(tableName);

    // Get rows to update
    const rows = applyWhere(table, sql, params);

    // Extract SET clause
    const setMatch = sql.match(/SET\s+(.+?)(?:\s+WHERE\s|\s+RETURNING\s|$)/i);
    if (!setMatch) return { rows, rowCount: rows.length };

    const assignments = splitValues(setMatch[1]);

    for (const row of rows) {
        for (const assign of assignments) {
            const eqMatch = assign.match(/(\w+)\s*=\s*(.+)/);
            if (!eqMatch) continue;

            const col = eqMatch[1].trim();
            let val = eqMatch[2].trim();

            // Handle expressions like coin_wallet + $1, COALESCE, etc.
            if (val.match(/^\$\d+$/)) {
                val = params[parseInt(val.substring(1)) - 1];
            } else if (val.toUpperCase() === 'NOW()') {
                val = new Date().toISOString();
            } else if (val.match(/\w+\s*\+\s*\$\d+/)) {
                // col + $N
                const ref = val.match(/(\w+)\s*\+\s*\$(\d+)/);
                if (ref) {
                    val = Number(row[ref[1]] || 0) + Number(params[parseInt(ref[2]) - 1]);
                }
            } else if (val.match(/\w+\s*-\s*\$\d+/)) {
                // col - $N
                const ref = val.match(/(\w+)\s*-\s*\$(\d+)/);
                if (ref) {
                    val = Number(row[ref[1]] || 0) - Number(params[parseInt(ref[2]) - 1]);
                }
            } else if (/COALESCE/i.test(val)) {
                const coalesceMatch = val.match(/COALESCE\((\w+),\s*(\d+)\)/i);
                if (coalesceMatch) {
                    const currentVal = row[coalesceMatch[1]];
                    const defaultVal = Number(coalesceMatch[2]);
                    // Check rest of expression
                    const restMatch = val.match(/COALESCE\([^)]+\)\s*\+\s*(\d+)/i);
                    if (restMatch) {
                        val = (currentVal !== null && currentVal !== undefined ? Number(currentVal) : defaultVal) + Number(restMatch[1]);
                    } else {
                        val = currentVal !== null && currentVal !== undefined ? currentVal : defaultVal;
                    }
                }
            } else {
                val = parseValue(val);
            }

            row[col] = val;
        }
        row.updated_at = new Date().toISOString();
    }

    const returning = /RETURNING\s+/i.test(sql);
    return { rows: returning ? rows : [], rowCount: rows.length };
}

function handleDelete(sql, params) {
    const tableMatch = sql.match(/DELETE\s+FROM\s+(\w+)/i);
    if (!tableMatch) return { rows: [], rowCount: 0 };

    const tableName = tableMatch[1];
    const table = getTable(tableName);
    const toDelete = applyWhere(table, sql, params);

    const ids = new Set(toDelete.map(r => r.id));
    tables[tableName] = table.filter(r => !ids.has(r.id));

    return { rows: [], rowCount: toDelete.length };
}

function handleSelect(sql, params) {
    // Detect main table
    const fromMatch = sql.match(/FROM\s+(\w+)(?:\s+(\w+))?/i);
    if (!fromMatch) return { rows: [], rowCount: 0 };

    const tableName = fromMatch[1];
    const alias = fromMatch[2] && !['WHERE', 'JOIN', 'LEFT', 'ORDER', 'LIMIT', 'GROUP', 'FOR'].includes(fromMatch[2].toUpperCase())
        ? fromMatch[2] : null;

    const table = getTable(tableName);
    let results = applyWhere(table, sql, params);

    // Handle JOINs (simplified — merge columns from joined tables)
    const joinRegex = /(?:LEFT\s+)?JOIN\s+(\w+)\s+(\w+)\s+ON\s+(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)/gi;
    let joinMatch;
    while ((joinMatch = joinRegex.exec(sql)) !== null) {
        const joinTable = getTable(joinMatch[1]);
        const joinAlias = joinMatch[2];
        const leftAlias = joinMatch[3];
        const leftCol = joinMatch[4];
        const rightAlias = joinMatch[5];
        const rightCol = joinMatch[6];

        const isLeft = /LEFT\s+JOIN/i.test(joinMatch[0]);

        results = results.map(row => {
            const joinRow = joinTable.find(jr => {
                const leftVal = row[leftCol] !== undefined ? row[leftCol] : row[rightCol];
                const rightVal = jr[rightCol] !== undefined ? jr[rightCol] : jr[leftCol];
                return leftVal == rightVal;
            });

            if (joinRow) {
                // Merge with prefix avoidance (don't overwrite existing)
                const merged = { ...row };
                for (const [k, v] of Object.entries(joinRow)) {
                    if (merged[k] === undefined) merged[k] = v;
                }
                return merged;
            }
            return isLeft ? row : null;
        }).filter(Boolean);
    }

    // Handle ORDER BY
    const orderMatch = sql.match(/ORDER\s+BY\s+(\w+(?:\.\w+)?)\s*(ASC|DESC)?/i);
    if (orderMatch) {
        const col = orderMatch[1].split('.').pop();
        const desc = orderMatch[2]?.toUpperCase() === 'DESC';
        results.sort((a, b) => {
            const av = a[col], bv = b[col];
            if (av == null && bv == null) return 0;
            if (av == null) return 1;
            if (bv == null) return -1;
            if (typeof av === 'string') return desc ? bv.localeCompare(av) : av.localeCompare(bv);
            return desc ? Number(bv) - Number(av) : Number(av) - Number(bv);
        });
    }

    // Handle LIMIT
    const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
    if (limitMatch) {
        results = results.slice(0, parseInt(limitMatch[1]));
    }

    // Handle column aliases in SELECT (simplified — return full rows)
    return { rows: results.map(r => ({ ...r })), rowCount: results.length };
}

// Client class (for transactions and pool.connect)
class Client {
    constructor() {
        this._inTransaction = false;
        this._snapshot = null;
    }

    async query(sql, params = []) {
        return executeQuery(sql, params);
    }

    async release() {
        // no-op for in-memory
    }
}

// Main db object
const db = {
    async query(sql, params = []) {
        return executeQuery(sql, params);
    },

    async transaction(callback) {
        const client = new Client();
        client._inTransaction = true;
        // Snapshot for rollback
        client._snapshot = JSON.parse(JSON.stringify(tables));
        try {
            await client.query('BEGIN');
            const result = await callback(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            // Rollback: restore snapshot
            for (const key of Object.keys(tables)) {
                if (client._snapshot[key]) {
                    tables[key] = client._snapshot[key];
                } else {
                    delete tables[key];
                }
            }
            throw error;
        }
    },

    pool: {
        async connect() {
            const client = new Client();
            // Add BEGIN/COMMIT/ROLLBACK support
            let snapshot = null;

            const originalQuery = client.query.bind(client);
            client.query = async (sql, params = []) => {
                const upper = sql.trim().toUpperCase();
                if (upper === 'BEGIN') {
                    snapshot = JSON.parse(JSON.stringify(tables));
                    return { rows: [], rowCount: 0 };
                }
                if (upper === 'COMMIT') {
                    snapshot = null;
                    return { rows: [], rowCount: 0 };
                }
                if (upper === 'ROLLBACK') {
                    if (snapshot) {
                        for (const key of Object.keys(tables)) {
                            if (snapshot[key]) {
                                tables[key] = snapshot[key];
                            } else {
                                delete tables[key];
                            }
                        }
                        snapshot = null;
                    }
                    return { rows: [], rowCount: 0 };
                }
                return originalQuery(sql, params);
            };

            return client;
        }
    },

    // For testing: access to raw tables
    _tables: tables,
    _reset() {
        for (const key of Object.keys(tables)) delete tables[key];
        for (const key of Object.keys(sequences)) delete sequences[key];
    }
};

module.exports = db;
