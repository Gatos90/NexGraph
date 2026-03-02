package store

import "database/sql"

type Database struct {
	conn *sql.DB
}

func (d *Database) Query(query string, args ...interface{}) (*sql.Rows, error) {
	return d.conn.Query(query, args...)
}

func (d *Database) Execute(query string, args ...interface{}) (sql.Result, error) {
	return d.conn.Exec(query, args...)
}

func (d *Database) Close() error {
	return d.conn.Close()
}

type CacheService struct {
	data map[string]interface{}
}

func (c *CacheService) Get(key string) (interface{}, bool) {
	val, ok := c.data[key]
	return val, ok
}

func (c *CacheService) Set(key string, value interface{}) {
	c.data[key] = value
}

func (c *CacheService) Delete(key string) {
	delete(c.data, key)
}

type Logger struct{}

func (l *Logger) Info(msg string, args ...interface{})  {}
func (l *Logger) Error(msg string, args ...interface{}) {}
func (l *Logger) Warn(msg string, args ...interface{})  {}
